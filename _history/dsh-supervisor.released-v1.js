#!/usr/bin/env node
/*
 * dsh-supervisor —— 让手机能远程把 PC 上的 dsh web 拉起来。
 *
 * 为什么必须有它：dsh web 一旦死了，PC 上就**没有任何东西在听**，手机再怎么发请求
 * 也没人接。重启之所以不需要它，是因为那时插件还跑在活着的进程里；启动不行——
 * 必须有一个生命周期独立于 dsh web 的常驻进程。
 *
 * 几条硬约束，都是实测踩出来的：
 *  1. 只监听 127.0.0.1。Windows 防火墙规则改动要管理员，而本机用户不是管理员。
 *     外网可达性交给 tailscale serve（跑在 Tailscale 服务里，本来就有权限）：
 *       tailscale serve --bg --https=443 --set-path=/super http://127.0.0.1:3099
 *     实测非管理员可执行，且不影响原有的 / 到 3080 的映射。
 *  2. 不能由 dsh 的工具子进程直接 spawn。dsh 用 Windows Job Object 并在关闭时连带
 *     杀子进程，detached:true 也逃不掉（DETACHED_PROCESS 不解除 Job 成员身份）。
 *     必须经 WMI（Win32_Process.Create）创建，父进程变成 WmiPrvSE.exe，在 Job 之外。
 *     install 脚本负责这件事。
 *  3. 判断 dsh web 死活只用 TCP 探测，不用 PID 记账 —— PID 会因重启失效，
 *     而端口有人监听是唯一可靠的存活信号。
 *  4. process.kill(0) 是禁区：它把信号发给整个进程组，会杀掉 supervisor 自己。
 *     这个 bug 实测触发过（/restart 48ms 返回 502）。下面还有一道显式拦截。
 *
 * 只做三件事：查状态、启动、重启。要求 token。只暴露在 tailnet 内。
 */
'use strict';

const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');

const CONFIG_PATH = process.env.DSH_SUPERVISOR_CONFIG ||
  path.join(__dirname, 'dsh-supervisor.config.json');

let config;
try {
  // 必须剥 BOM：Windows 上 Set-Content -Encoding UTF8（PS 5.1）和记事本都会在开头
  // 写 EF BB BF，而 JSON.parse 把 U+FEFF 当非法字符直接抛异常 —— 表现是「配置内容
  // 明明正确，进程却启动即退，连日志都没来得及写」。与其要求每个生成配置的工具都
  // 写无 BOM，不如在读取侧一次性容错。
  const text = fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '');
  config = JSON.parse(text);
} catch (error) {
  console.error('[dsh-supervisor] 读不到配置 ' + CONFIG_PATH + '：' + error.message);
  process.exit(1);
}

const PORT = Number(config.port || 3099);
const HOST = config.host || '127.0.0.1';
const TOKEN = String(config.token || '');
const DSH = config.dsh || {};
const DSH_PORT = DSH.port || 3080;
const LOG = config.log || path.join(os.homedir(), '.dsh', 'supervisor.log');

if (!TOKEN) {
  console.error('[dsh-supervisor] 配置里没有 token，拒绝启动');
  process.exit(1);
}

// 日志：追加写，超限自动清空
function log(message) {
  const line = new Date().toISOString() + ' ' + message + '\n';
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    try {
      if (fs.statSync(LOG).size > 262144) fs.writeFileSync(LOG, '');
    } catch { /* 文件还不存在 */ }
    fs.appendFileSync(LOG, line);
  } catch { /* 日志失败绝不能影响主流程 */ }
}

// TCP 存活探测
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

// 按端口反查 PID
//
// dsh web 可能不是本实例起的（本来就在跑，或被别的实例拉起来过），这时没有它的 PID。
// 绝不能用 process.kill(0) 兜底 —— 那是杀整个进程组，会把 supervisor 自己一起带走
// （实测过：/restart 48ms 返回 502，supervisor 自杀而 dsh web 反而活着，因为两者
// 不在同一进程组）。
//
// 实现刻意不用正则：netstat -ano 的 LISTENING 行按空白切分正好五段
// [协议, 本地地址, 外部地址, 状态, PID]，按位置取值比写正则更不容易出错
// （早先那版正则少匹配一段字段，导致永远匹配不上、静默退化成不杀进程）。
function findPidByPort(port) {
  try {
    const out = execFileSync('netstat', ['-ano'], {
      encoding: 'utf8', windowsHide: true, timeout: 8000,
    });
    const needle = ':' + port;
    for (const line of out.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5) continue;
      if (parts[3].toUpperCase() !== 'LISTENING') continue;
      // endsWith 而不是 includes：避免 :3080 误配 :30800
      if (parts[1].endsWith(needle)) return Number(parts[4]);
    }
  } catch { /* netstat 不可用，返回 null，调用方退化成「不杀，直接起」 */ }
  return null;
}

let launchedPid = null;
let launchedAt = null;

async function status() {
  const alive = await probe(DSH_PORT);
  return {
    running: alive,
    // 明确区分两个端口：dshWebPort 是被监视的（dsh web 的），supervisorPort 是本
    // 进程监听的。都叫 port 会让人以为主管进程跑在 3080。
    dshWebPort: DSH_PORT,
    supervisorPort: PORT,
    launchedPid: alive ? launchedPid : null,
    launchedAt,
    supervisorPid: process.pid,
    uptimeSec: Math.round(process.uptime()),
  };
}

// 启动 dsh web
//
// supervisor 自己是 WMI 创建的（在 dsh 的 Job 之外），所以它 spawn 出来的 dsh web
// 也不会进 Job。这正是整条链路成立的原因。
// 启动 dsh web
//
// supervisor 自己是 WMI 创建的（在 dsh 的 Job 之外），所以它 spawn 出来的 dsh web
// 也不会进 Job。这正是整条链路成立的原因。
//
// 返回 Promise 而不是 PID：spawn 找不到可执行文件时**不会**同步抛异常，而是异步发
// error 事件。早先直接返回 child.pid 的写法漏接了这个事件，结果是 uncaughtException
// 加上 HTTP 请求永远挂住不返回（本地冒烟测试抓到的）。
function startDshWeb() {
  return new Promise((resolve, reject) => {
    const node = DSH.node || process.execPath;
    const argv = [
      ...(DSH.execArgv || []),
      ...(DSH.bin ? [DSH.bin] : []),
      ...(DSH.args || ['web', '--no-open']),
    ];
    let child;
    try {
      child = spawn(node, argv, {
        cwd: DSH.cwd || os.homedir(),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, ...(DSH.env || {}) },
      });
    } catch (error) {
      // 同步抛（参数非法等）
      log('spawn 同步失败：' + (error && error.message ? error.message : error));
      return reject(error);
    }
    child.once('error', (error) => {
      log('spawn 异步失败：' + (error && error.message ? error.message : error));
      reject(error);
    });
    child.once('spawn', () => {
      child.unref();
      launchedPid = child.pid ?? null;
      launchedAt = new Date().toISOString();
      log('started dsh web pid=' + launchedPid + ' argv=' + JSON.stringify(argv));
      resolve(launchedPid);
    });
  });
}

async function waitForPort(port, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe(port, 800)) return true;
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

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
  // 刻意不支持 ?token= —— query string 会进访问日志、Referer 和各种中间层，
  // 等于给这个 token 多开几条泄漏路径。只认请求头。
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
      return json(res, 200, { ok: true, ...(await status()) });
    }

    if (req.method === 'POST' && route === '/start') {
      const before = await status();
      if (before.running) {
        return json(res, 200, { ok: true, started: false, alreadyRunning: true, ...before });
      }
      let pid;
      try {
        pid = await startDshWeb();
      } catch (error) {
        // 拉不起来要明确回错，不能让请求挂住 —— 上层（App）靠这个判断该不该提示用户
        return json(res, 500, { ok: false, error: 'spawn-failed', message: String((error && error.message) || error) });
      }
      const ok = await waitForPort(DSH_PORT);
      return json(res, 200, { ok: true, started: true, listening: ok, pid, ...(await status()) });
    }

    if (req.method === 'POST' && route === '/restart') {
      const was = await status();
      if (was.running) {
        // 优先用自己记的 PID，没有就按端口反查。
        // 绝不能 fallback 到 0 —— kill(0) 会连 supervisor 自己一起杀。
        const target = was.launchedPid || findPidByPort(DSH_PORT);
        if (target) {
          try { process.kill(target); } catch { /* 已经退了 */ }
        } else {
          log('restart: ' + DSH_PORT + ' 有监听但查不到 PID，跳过 kill 直接启动');
        }
        for (let i = 0; i < 40; i++) {
          if (!(await probe(DSH_PORT, 500))) break;
          await new Promise((r) => setTimeout(r, 400));
        }
      }
      let pid;
      try {
        pid = await startDshWeb();
      } catch (error) {
        return json(res, 500, { ok: false, error: 'spawn-failed', message: String((error && error.message) || error) });
      }
      const ok = await waitForPort(DSH_PORT);
      return json(res, 200, { ok: true, restarted: true, listening: ok, pid, ...(await status()) });
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

// 兜底：kill(0) 杀整个进程组（含自己）。实测发生过，显式拦一道。
const _kill = process.kill.bind(process);
process.kill = (pid, signal) => {
  if (pid === 0) {
    log('拦截了一次 process.kill(0)：它会杀掉 supervisor 自己，已忽略');
    return false;
  }
  return _kill(pid, signal);
};

process.on('uncaughtException', (e) => log('uncaughtException：' + (e && e.stack ? e.stack : e)));
process.on('unhandledRejection', (e) => log('unhandledRejection：' + (e && e.stack ? e.stack : e)));
