#!/usr/bin/env node
/*
 * dsh-supervisor —— 让手机能远程把 PC 上的 dsh web 拉起来。
 *
 * 为什么必须有它：dsh web 一旦死了，PC 上就**没有任何东西在听**，手机再怎么发请求
 * 也没人接。重启之所以不需要它，是因为那时插件还跑在活着的进程里。启动不行 ——
 * 必须有一个生命周期独立于 dsh web 的常驻进程。
 *
 * 设计上的几个硬约束（都是踩出来的）：
 *  1. 只监听 127.0.0.1 —— Windows 防火墙规则改动要管理员，而 sun 不是管理员。
 *     外网可达性交给 `tailscale serve`（它跑在 Tailscale 服务里，已有权限）。
 *     已实测：`tailscale serve --bg --https=443 --set-path=/super http://127.0.0.1:3081`
 *     非管理员可执行，且不影响原有的 / → 3080。
 *  2. **不能由 dsh 的工具子进程直接 spawn** —— dsh 用 Windows Job Object 并在关闭时
 *     连带杀子进程，`detached:true` 也逃不掉。必须经 WMI（Win32_Process.Create）创建，
 *     这样父进程是 WmiPrvSE.exe，在 Job 之外。install 脚本负责这件事。
 *  3. 判断 dsh web 死活用 **TCP 探测**，不用 PID 记账 —— PID 会因为重启而失效，
 *     而端口监听是唯一可靠的存活信号。
 *  4. 拉起 dsh web 时用 `windowsHide` + `detached` + `unref`，并显式传 cwd，
 *     否则 dsh 会以 supervisor 的目录为工作区。
 *
 * 安全：只做三件事（查状态 / 启动 / 重启），且要求 token。
 * 只暴露在 tailnet 内（tailscale serve 是 "tailnet only"），不是公网。
 */
'use strict';

const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const CONFIG_PATH = process.env.DSH_SUPERVISOR_CONFIG ||
  path.join(__dirname, 'dsh-supervisor.config.json');

let config;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (error) {
  // 配不出来就直接退出：宁可没有 supervisor，也不要一个行为不确定的监听器。
  console.error('[dsh-supervisor] 读不到配置 ' + CONFIG_PATH + '：' + error.message);
  process.exit(1);
}

const PORT = Number(config.port || 3081);
const HOST = config.host || '127.0.0.1';
const TOKEN = String(config.token || '');
const DSH = config.dsh || {};
const LOG = config.log || path.join(os.homedir(), '.dsh', 'supervisor.log');

if (!TOKEN) {
  console.error('[dsh-supervisor] 配置里没有 token，拒绝启动');
  process.exit(1);
}

// ── 日志：追加写，自动截断，避免把磁盘写满 ──────────────────────────────
function log(message) {
  const line = new Date().toISOString() + ' ' + message + '\n';
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    // 超过 256 KB 就重开，简单粗暴但够用
    try {
      if (fs.statSync(LOG).size > 262144) fs.writeFileSync(LOG, '');
    } catch { /* 文件不存在，无所谓 */ }
    fs.appendFileSync(LOG, line);
  } catch { /* 日志失败绝不能影响主流程 */ }
}

// ── TCP 存活探测 ────────────────────────────────────────────────────────
function probe(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const finish = (alive) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(alive);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

// 记下我们自己拉起来的 dsh web，便于 /health 回报
let launchedPid = null;
let launchedAt = null;

async function status() {
  const alive = await probe(DSH.port || 3080);
  return {
    running: alive,
    port: DSH.port || 3080,
    launchedPid: alive ? launchedPid : null,
    launchedAt,
    supervisorPid: process.pid,
    uptimeSec: Math.round(process.uptime()),
  };
}

// ── 启动 dsh web ────────────────────────────────────────────────────────
//
// 关键：supervisor 自己是 WMI 创建的（在 dsh 的 Job 之外），所以它 spawn 出来的
// dsh web **也不会**进 Job。这正是整条链路能成立的原因。
function startDshWeb() {
  const node = DSH.node || process.execPath;
  const argv = [...(DSH.execArgv || []), ...(DSH.bin ? [DSH.bin] : []), ...(DSH.args || ['web', '--no-open'])];
  const child = spawn(node, argv, {
    cwd: DSH.cwd || os.homedir(),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ...(DSH.env || {}) },
  });
  child.unref();
  launchedPid = child.pid ?? null;
  launchedAt = new Date().toISOString();
  log('started dsh web pid=' + launchedPid + ' argv=' + JSON.stringify(argv));
  return launchedPid;
}

// 等端口起来，成功即返回 true
async function waitForPort(port, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe(port, 800)) return true;
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

// ── HTTP ────────────────────────────────────────────────────────────────
function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function authorized(req, url) {
  const header = req.headers['x-dsh-supervisor-token'];
  if (typeof header === 'string' && header === TOKEN) return true;
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ') && auth.slice(7) === TOKEN) return true;
  // 也允许 ?token= —— 有些 HTTP 客户端加自定义头不方便
  if (url.searchParams.get('token') === TOKEN) return true;
  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const route = url.pathname.replace(/\/+$/, '') || '/';

  if (!authorized(req, url)) {
    log('401 ' + req.method + ' ' + route + ' from ' + (req.socket.remoteAddress || '?'));
    return json(res, 401, { ok: false, error: 'unauthorized' });
  }

  try {
    if (req.method === 'GET' && (route === '/health' || route === '/' || route === '/super')) {
      const s = await status();
      return json(res, 200, { ok: true, ...s });
    }

    if (req.method === 'POST' && route === '/start') {
      const before = await status();
      if (before.running) {
        return json(res, 200, { ok: true, started: false, alreadyRunning: true, ...before });
      }
      const pid = startDshWeb();
      const ok = await waitForPort(DSH.port || 3080);
      return json(res, 200, {
        ok: true,
        started: true,
        listening: ok,
        pid,
        ...(await status()),
      });
    }

    if (req.method === 'POST' && route === '/restart') {
      // 先杀再起。用于 dsh web 卡死但端口还占着的情况。
      const was = await status();
      if (was.running) {
        try { process.kill(was.launchedPid || 0); } catch { /* 可能不是我们起的 */ }
        // 端口不一定马上释放，等它掉
        for (let i = 0; i < 30; i++) {
          if (!(await probe(DSH.port || 3080, 500))) break;
          await new Promise((r) => setTimeout(r, 400));
        }
      }
      const pid = startDshWeb();
      const ok = await waitForPort(DSH.port || 3080);
      return json(res, 200, { ok: true, restarted: true, listening: ok, pid });
    }

    return json(res, 404, { ok: false, error: 'no-such-route', route });
  } catch (error) {
    log('500 ' + req.method + ' ' + route + '：' + (error && error.stack ? error.stack : error));
    return json(res, 500, { ok: false, error: String((error && error.message) || error) });
  }
});

server.on('error', (error) => {
  log('server error：' + (error && error.stack ? error.stack : error));
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  log('listening on ' + HOST + ':' + PORT + ' pid=' + process.pid + ' ppid=' + process.ppid);
});

// supervisor 自己绝不能因为未捕获异常而悄悄死掉 —— 死了就没人能远程救 dsh web 了
process.on('uncaughtException', (error) => log('uncaughtException：' + (error && error.stack ? error.stack : error)));
process.on('unhandledRejection', (error) => log('unhandledRejection：' + (error && error.stack ? error.stack : error)));
