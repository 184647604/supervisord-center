#!/usr/bin/env node
/*
 * supervisord-center —— 常驻的服务托管中枢，带 token 保护的 HTTP 控制面 + Web 管理页。
 *
 * 名字：supervisord 取自 Unix 守护进程命名传统（sshd / crond / httpd），
 * center 指它同时是一个「中心」—— 不只守一个进程，而是统一托管本机若干服务，
 * 并经 Tailscale Serve 暴露给 tailnet 内的设备远程管理。
 *   （加 center 还有个现实原因：supervisord 是 Python Supervisor 的守护进程
 *     二进制名，GitHub 上精确同名 527 个仓库，裸名没法用。）
 *
 * 为什么必须有它：被托管的服务一旦死了，本机上就**没有任何东西在听**，
 * 手机再怎么发请求也没人接。重启之所以不需要它，是因为那时插件还跑在活着的
 * 进程里；启动不行 —— 必须有一个生命周期独立于被托管服务的常驻进程。
 *
 * ── 职责边界（用户明确过的）────────────────────────────────────────────
 *  要：① 看到有哪些服务 ② 看到每个在线/离线 ③ 离线时能拉起来
 *  不要：精细的停止/编排。几个被托管服务的 .cmd 里有 :loop 自愈循环，
 *        杀了会被立刻拉回来 —— 用户明确说「这个没有影响」。
 *  所以 /stop 是「尽力而为」，不是核心语义；重启之所以能生效，靠的是
 *  **连包装器一起杀**（见 killService），而不是指望服务乖乖待着不动。
 *
 * ── 从 dsh-supervisor 继承的硬约束（全是实测踩出来的，别删）──────────────
 *  1. 只监听 127.0.0.1。Windows 防火墙规则改动要管理员，而普通用户不是管理员。
 *     外网可达性交给隧道（tailscale serve 跑在服务账号里，本来就有权限）：
 *       tailscale serve --bg --https=443 --set-path=/super http://127.0.0.1:3099
 *  2. 不能由任何会被回收的父进程直接 spawn。上层若用 Windows Job Object 管理
 *     子进程并在关闭时连带清理，detached:true 也逃不掉（DETACHED_PROCESS 不解除
 *     Job 成员身份）。必须经 WMI（Win32_Process.Create）创建，父进程变成
 *     WmiPrvSE.exe，在 Job 之外。install 脚本负责这件事。
 *  3. 判断被托管服务死活只用 TCP 探测，不用 PID 记账 —— PID 会因重启失效，
 *     而端口有人监听是唯一可靠的存活信号。
 *  4. process.kill(0) 是禁区：它把信号发给整个进程组，会杀掉本进程自己。
 *     这个 bug 实测触发过（/restart 48ms 返回 502）。下面还有一道显式拦截。
 *  5. 读配置必须剥 BOM：Windows 上 Set-Content -Encoding UTF8（PS 5.1）和记事本
 *     都会在开头写 EF BB BF，而 JSON.parse 把 U+FEFF 当非法字符直接抛异常 ——
 *     表现是「配置内容明明正确，进程却启动即退，连日志都没来得及写」。
 *  6. spawn 找不到可执行文件时**不会**同步抛异常，而是异步发 error 事件。
 *     早先直接返回 child.pid 的写法漏接了这个事件，结果是 uncaughtException
 *     加上 HTTP 请求永远挂住不返回（本地冒烟测试抓到的）。
 *  7. 刻意不支持 ?token= —— query string 会进访问日志、Referer 和各种中间层，
 *     等于给 token 多开几条泄漏路径。只认请求头。
 *     Web 管理页要靠浏览器，而浏览器没法给页面导航设请求头，所以走
 *     「POST 表单提交 token → 换 HttpOnly Cookie」这条路（见 handleLogin）。
 *     token 在 body 里，不进 URL，同样是刻意避开 query string。
 *  8. spawn .cmd 包装器必须带 detached:true，否则 :loop 里的 `timeout` 会失败
 *     （它要真控制台），循环退化成**紧循环**：实测 detached:false 时 7 秒跑
 *     166 次，detached:true 时 7 秒 2 次。这条是跑 tools/probe-launch.js 量出来的，
 *     不是推理出来的。同一个探针也确认了 detached:true 不影响服务正常启动。
 *
 * 安全：查状态 / 启动 / 停止 / 重启，全部要求 token。只暴露在 tailnet 内
 * （tailscale serve 默认 "tailnet only"），不是公网。
 */
'use strict';

const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

// 运行时目录：~/.supervisord-center
//
// 刻意**不放在任何被托管服务的目录下**。这是「完全独立」的一部分：本进程托管
// 别的服务，但它自己的生命周期、配置、日志都不该跟那些服务的目录纠缠 ——
// 对方被卸载/重装/换 HOME 都不该影响这里，反过来也一样。
const RUNTIME_DIR = process.env.SUPERVISORD_CENTER_HOME ||
  path.join(os.homedir(), '.supervisord-center');

// 配置查找：按顺序找第一个存在的。
//
// 为什么不在 __dirname 里写死一个路径：这个脚本有**两种合法摆放方式** ——
//   (a) 直接在项目里跑（src/supervisord-center.js → ../config/…）
//   (b) 被拷到别处当单文件跑（配置就在它旁边）
// 而迁移期还可能留着旧路径。写死单点会让「配置文件到底该放哪」变成一个每次
// 都要重新推理的问题 —— 这类困惑浪费的时间和 BOM 那个坑是同一量级。
// 因此逐个候选探测，并把**实际选中**的那个记进日志，排错时一眼可见。
const CONFIG_CANDIDATES = [
  process.env.SUPERVISORD_CENTER_CONFIG,
  path.join(__dirname, '..', 'config', 'supervisord-center.config.json'),
  path.join(__dirname, 'supervisord-center.config.json'),
  path.join(RUNTIME_DIR, 'supervisord-center.config.json'),
].filter(Boolean);

let config = null;
let CONFIG_PATH = null;
let lastError = null;
for (const candidate of CONFIG_CANDIDATES) {
  try {
    // 必须剥 BOM —— 见文件头第 5 条。与其要求每个生成配置的工具都写无 BOM，
    // 不如在读取侧一次性容错。
    const text = fs.readFileSync(candidate, 'utf8').replace(/^\uFEFF/, '');
    config = JSON.parse(text);
    CONFIG_PATH = candidate;
    break;
  } catch (error) {
    lastError = error;
  }
}
if (!config) {
  console.error('[supervisord-center] 找不到可用配置。依次试过：\n  ' +
    CONFIG_CANDIDATES.join('\n  ') +
    '\n最后一个错误：' + (lastError && lastError.message ? lastError.message : lastError));
  process.exit(1);
}

const PORT = Number(config.port || 3099);
const HOST = config.host || '127.0.0.1';
const TOKEN = String(config.token || '');
const LOG = config.log || path.join(RUNTIME_DIR, 'logs', 'center.log');
// 启动后等端口就绪的上限。冷启动慢的服务（首次加载、建索引）要十几秒，
// 快的一两秒就够。用同一个上限是为了避免「每个服务一个魔数」。
const START_WAIT_MS = Number(config.startWaitMs || 25000);
// tailnet 根地址，只用于在管理页上拼出可点的链接（纯粹是显示用途）。
const TAILNET_BASE = String(config.tailnetBase || '').replace(/\/+$/, '');

if (!TOKEN) {
  console.error('[supervisord-center] 配置里没有 token，拒绝启动');
  process.exit(1);
}

// ── 服务清单 ────────────────────────────────────────────────────────────
//
// 兼容旧的单服务配置：老配置里是一个 `dsh` 对象，新版是 `services` 数组。
// 手机 App 已经按老字段名解析 /health，所以两条路都必须活着 —— 配置层做
// 归一化，比在运行时到处写 if 干净。
//
// 字段：
//   id        稳定标识，出现在 URL 里（/services/<id>/start），别随便改
//   name      显示名
//   port      存活探测端口，也是「在线/离线」的唯一判据
//   via       'node' = 直接起可执行文件；'cmd' = 起 .cmd 包装器（带 :loop 自愈）
//   node/bin/args/execArgv/env/cwd   via=node 时用
//   file      via=cmd 时用（.cmd 的绝对路径）
//   path      tailnet 上的路径前缀，用于拼链接
//   autostart 本进程启动后是否顺手把它拉起来（默认 false）
//   healthPath 可选，额外的 HTTP 探针，只作为补充信息展示
function normalizeServices(cfg) {
  if (Array.isArray(cfg.services) && cfg.services.length) {
    return cfg.services.map((s, i) => ({
      id: String(s.id || 'svc' + (i + 1)),
      name: String(s.name || s.id || 'svc' + (i + 1)),
      port: Number(s.port) || 0,
      via: s.via === 'cmd' ? 'cmd' : 'node',
      node: s.node || process.execPath,
      bin: s.bin || '',
      file: s.file || '',
      execArgv: s.execArgv || [],
      args: s.args || [],
      env: s.env || {},
      cwd: s.cwd || os.homedir(),
      path: s.path || '',
      autostart: s.autostart === true,
      healthPath: s.healthPath || '',
      note: s.note || '',
    }));
  }
  // 旧配置：只有一个 dsh 块
  const d = cfg.dsh || {};
  return [{
    id: 'dsh',
    name: 'DSH Web GUI',
    port: Number(d.port) || 3080,
    via: 'node',
    node: d.node || process.execPath,
    bin: d.bin || '',
    file: '',
    execArgv: d.execArgv || [],
    args: d.args || ['web', '--no-open'],
    env: d.env || {},
    cwd: d.cwd || os.homedir(),
    path: '/',
    autostart: false,
    healthPath: '',
    note: 'legacy single-service config',
  }];
}

const SERVICES = normalizeServices(config);
// 旧接口 /start /restart 指向哪个服务。默认第一个（旧配置里就是 dsh）。
const DEFAULT_SERVICE_ID = String(config.defaultService || (SERVICES[0] && SERVICES[0].id) || 'dsh');

function serviceById(id) {
  return SERVICES.find((s) => s.id === id) || null;
}

// ── 日志：追加写，超限自动清空 ──────────────────────────────────────────
function log(message) {
  const line = new Date().toISOString() + ' ' + message + '\n';
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    try {
      // 256 KB 就清空：简单粗暴但够用，重点是绝不把磁盘写满。
      if (fs.statSync(LOG).size > 262144) fs.writeFileSync(LOG, '');
    } catch { /* 文件还不存在 */ }
    fs.appendFileSync(LOG, line);
  } catch { /* 日志失败绝不能影响主流程 */ }
}

// ── TCP 存活探测 ────────────────────────────────────────────────────────
function probe(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    if (!port) return resolve(false);
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

// 可选的 HTTP 探针：只作为补充信息（端口通但 HTTP 500 也是有用的信号）。
function httpProbe(port, healthPath) {
  return new Promise((resolve) => {
    if (!port || !healthPath) return resolve(null);
    const req = http.get({ host: '127.0.0.1', port, path: healthPath, timeout: 2500 }, (res) => {
      res.resume();
      resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 400 });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, ok: false, error: 'timeout' }); });
    req.on('error', (e) => resolve({ status: 0, ok: false, error: e.code || e.message }));
  });
}

// ── 按端口反查 PID ──────────────────────────────────────────────────────
//
// 被托管服务可能不是本实例起的（本来就在跑，或被别的实例拉起来过），这时没有它的
// PID。绝不能用 process.kill(0) 兜底 —— 那是杀整个进程组，会把本进程自己一起带走
// （实测过：/restart 48ms 返回 502，supervisor 自杀而被托管服务反而活着，因为两者
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

// ── 找 .cmd 包装器进程 ──────────────────────────────────────────────────
//
// 为什么需要：有 :loop 的包装器在服务被杀掉后 5 秒就把它拉回来，只按端口杀
// 会变成「你杀我起」的拉锯。要真正停住，必须**连包装器一起杀** —— 这也是
// killService 能生效的全部原因。
//
// 过滤放在 JS 里做，不塞进 PowerShell 命令行：路径里有空格和反斜杠，拼进
// -Command 需要多层转义，而且容易写出注入口子。让 PS 只负责吐 JSON。
function listCmdProcesses() {
  try {
    const out = execFileSync('powershell', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | " +
      'Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress',
    ], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const trimmed = (out || '').trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch { return []; }
}

function findWrapperPid(launcherFile) {
  if (!launcherFile) return null;
  // 大小写不敏感：Windows 路径不区分大小写，而 CommandLine 里的写法
  // 取决于谁启动的它（Explorer / 计划任务 / WMI 各不相同）。
  const needle = launcherFile.toLowerCase();
  const hit = listCmdProcesses().find((p) =>
    p && typeof p.CommandLine === 'string' && p.CommandLine.toLowerCase().includes(needle));
  return hit ? Number(hit.ProcessId) : null;
}

// taskkill /T 杀整棵子树。/F 是必须的：没有控制台可以发 Ctrl+C 之类的软信号。
function killTree(pid, why) {
  if (!pid) return false;
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore', windowsHide: true, timeout: 10000,
    });
    log('killed tree pid=' + pid + ' (' + why + ')');
    return true;
  } catch (error) {
    log('kill 失败 pid=' + pid + ' (' + why + ')：' + (error && error.message ? error.message : error));
    return false;
  }
}

const launched = new Map(); // id -> { pid, at }

// ── 状态 ────────────────────────────────────────────────────────────────
async function serviceStatus(svc) {
  const running = await probe(svc.port);
  const rec = launched.get(svc.id);
  const extra = await httpProbe(svc.port, svc.healthPath);
  return {
    id: svc.id,
    name: svc.name,
    running,
    port: svc.port,
    // 记的是「本实例拉起来的」PID；服务本来就在跑（或别人起的）时是 null。
    // 不要拿它当存活判据 —— 存活一律看 running。
    launchedPid: running && rec ? rec.pid : null,
    launchedAt: rec ? rec.at : null,
    pid: running ? findPidByPort(svc.port) : null,
    localUrl: svc.port ? 'http://127.0.0.1:' + svc.port + (svc.path && svc.path !== '/' ? svc.path : '/') : '',
    tailnetUrl: TAILNET_BASE && svc.path ? TAILNET_BASE + svc.path : '',
    autostart: svc.autostart,
    note: svc.note,
    http: extra,
  };
}

async function allStatus() {
  return Promise.all(SERVICES.map((s) => serviceStatus(s)));
}

// ── 启动 ────────────────────────────────────────────────────────────────
//
// 本进程自己是 WMI 创建的（在被托管服务的 Job 之外），所以它 spawn 出来的子进程
// 也不会进那个 Job。这正是整条链路成立的原因。
//
// 返回 Promise 而不是 PID：spawn 找不到可执行文件时**不会**同步抛异常，而是异步发
// error 事件。早先直接返回 child.pid 的写法漏接了这个事件，结果是 uncaughtException
// 加上 HTTP 请求永远挂住不返回（本地冒烟测试抓到的）。
function spawnService(svc) {
  return new Promise((resolve, reject) => {
    let file;
    let argv;
    if (svc.via === 'cmd') {
      // detached:true 是必须的 —— 见文件头第 8 条。少了它，包装器里
      // `timeout /t 5` 会因为拿不到控制台而立刻失败，:loop 变成紧循环。
      file = process.env.ComSpec || 'cmd.exe';
      argv = ['/c', svc.file];
    } else {
      file = svc.node || process.execPath;
      argv = [
        ...(svc.execArgv || []),
        ...(svc.bin ? [svc.bin] : []),
        ...(svc.args || []),
      ];
    }

    let child;
    try {
      child = spawn(file, argv, {
        // 显式传 cwd：否则被托管服务会以本进程的目录为工作区（实测过：某些
        // 服务的工作区取自 process.cwd()，传错会导致它的数据落到 supervisor 目录）。
        cwd: svc.cwd || os.homedir(),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, ...(svc.env || {}) },
      });
    } catch (error) {
      // 同步抛（参数非法等）
      log('[' + svc.id + '] spawn 同步失败：' + (error && error.message ? error.message : error));
      return reject(error);
    }
    child.once('error', (error) => {
      log('[' + svc.id + '] spawn 异步失败：' + (error && error.message ? error.message : error));
      reject(error);
    });
    child.once('spawn', () => {
      child.unref();
      launched.set(svc.id, { pid: child.pid ?? null, at: new Date().toISOString() });
      log('[' + svc.id + '] started pid=' + child.pid + ' via=' + svc.via + ' argv=' + JSON.stringify(argv));
      resolve(child.pid);
    });
  });
}

async function waitForPort(port, timeoutMs = START_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe(port, 800)) return true;
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

async function startService(svc) {
  const before = await serviceStatus(svc);
  if (before.running) {
    // 幂等：已经在跑就什么都不做。这不是可选的优化 —— 被托管服务的端口是
    // 独占的，重复起一个只会得到一个立刻崩掉的实例，而带 :loop 的包装器
    // 会把它每 5 秒重拉一次，变成无休止的崩溃循环。
    return { ok: true, started: false, alreadyRunning: true, target: svc.id, ...(await statusShim(svc)) };
  }
  let pid;
  try {
    pid = await spawnService(svc);
  } catch (error) {
    // 拉不起来要明确回错，不能让请求挂住 —— 上层（App）靠这个判断该不该提示用户
    return { ok: false, status: 500, error: 'spawn-failed', target: svc.id, message: String((error && error.message) || error) };
  }
  const listening = await waitForPort(svc.port);
  return { ok: true, started: true, listening, pid, target: svc.id, ...(await statusShim(svc)) };
}

// 旧 /health 的字段名（dshWebPort / supervisorPort）必须保留：手机 App 侧可能
// 已经在解析它们，改名属于破坏性变更。这里把默认服务的端口映射回旧名字。
async function statusShim(svc) {
  const dsh = svc || serviceById(DEFAULT_SERVICE_ID) || SERVICES[0] || { port: 0 };
  const st = await serviceStatus(dsh);
  return {
    running: st.running,
    dshWebPort: dsh.port,
    targetPort: dsh.port,
    supervisorPort: PORT,
    centerPort: PORT,
    launchedPid: st.launchedPid,
    launchedAt: st.launchedAt,
    supervisorPid: process.pid,
    centerPid: process.pid,
    uptimeSec: Math.round(process.uptime()),
  };
}

async function status() {
  return statusShim(serviceById(DEFAULT_SERVICE_ID));
}

// ── 停止 ────────────────────────────────────────────────────────────────
//
// 顺序有讲究：**先杀包装器，再杀端口占用者**。
// 反过来的话，包装器的 :loop 会在你杀完服务后 5 秒把它拉回来，你看到的现象是
// 「停止成功了但服务还在」。
// 杀包装器用 /T，它的子进程（也就是真正监听端口的那个）会一起走。
async function stopService(svc) {
  const was = await serviceStatus(svc);
  let wrapperKilled = false;
  let portPidKilled = false;

  const wrapperPid = svc.via === 'cmd' ? findWrapperPid(svc.file) : null;
  if (wrapperPid) wrapperKilled = killTree(wrapperPid, svc.id + ' wrapper');

  const portPid = findPidByPort(svc.port);
  if (portPid) portPidKilled = killTree(portPid, svc.id + ' port ' + svc.port);

  if (!wrapperPid && !portPid && !was.running) {
    return { ok: true, stopped: false, alreadyStopped: true, target: svc.id, ...(await statusShim(svc)) };
  }

  // 等端口真正释放，最多 8 秒
  for (let i = 0; i < 20; i++) {
    if (!(await probe(svc.port, 500))) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  launched.delete(svc.id);
  const after = await serviceStatus(svc);

  if (after.running && svc.via === 'cmd') {
    // 说实话：带 :loop 的包装器若还活着（例如它以别的姿势启动，命令行里
    // 没有我们认得的路径），它会自己回来。这不算失败，但必须如实报告。
    log('[' + svc.id + '] 停止后仍在监听 —— 可能有自愈包装器把它拉回来了');
  }
  return {
    ok: true, stopped: !after.running, stillRunning: after.running,
    wrapperKilled, portPidKilled, target: svc.id, ...(await statusShim(svc)),
  };
}

async function restartService(svc) {
  await stopService(svc);
  const r = await startService(svc);
  return { ...r, restarted: r.ok !== false, started: r.ok !== false };
}

function json(res, code, body, extraHeaders) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...(extraHeaders || {}),
  });
  res.end(text);
}

// ── 鉴权 ────────────────────────────────────────────────────────────────
//
// 请求头（脚本/App）与 Cookie（浏览器管理页）两条路。
// 刻意不支持 ?token= —— 见文件头第 7 条。
//
// Cookie 里放的不是 token 本身，而是 HMAC(TOKEN, 固定串)。理由：token 是长期
// 凭据，浏览器会把它写进磁盘的 cookie 库；派生值同样能证明「你持有 token」，
// 但泄漏出去不能直接当 API token 用，而且换 token 就自动失效。
function sessionValue() {
  return crypto.createHmac('sha256', TOKEN).update('supervisord-center-session-v1').digest('hex');
}

function timingSafeEq(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function parseCookies(req) {
  const raw = req.headers.cookie;
  const out = {};
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function authorized(req) {
  const header = req.headers['x-supervisord-center-token'];
  if (typeof header === 'string' && timingSafeEq(header, TOKEN)) return true;
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ') && timingSafeEq(auth.slice(7), TOKEN)) return true;
  const cookie = parseCookies(req).sdc_session;
  if (typeof cookie === 'string' && timingSafeEq(cookie, sessionValue())) return true;
  return false;
}

// ── 登录限流 ────────────────────────────────────────────────────────────
//
// 为什么需要：token 是可配置的，一旦选成人能记住的短串（例如纯数字手机号），
// 搜索空间就比随机串小几个数量级，而登录接口本身没有任何节流。
// 阈值取「10 分钟 8 次」是为了跟同类管理台保持一致的直觉。
//
// 按来源 IP 分桶。**实测：经反向代理进来的请求 remoteAddress 全是
// 127.0.0.1**（代理从本机回环转发），所以实际只有一个桶 —— 也就是全局限流。
// 这对本工具是**想要**的行为：单用户，攻击者没法靠换源 IP 绕过。
// 但代码仍按 IP 分桶而不是写死全局，这样直连（不经代理）时语义依然正确。
//
// 代价要说清楚：全局桶意味着攻击者可以把桶打满，让**你自己**暂时登不进去。
// 这是有意的取舍 —— 短暂登不上，好过被无限次猜测。成功登录会清空计数，
// 所以正常使用不会累积。
const LOGIN_MAX_FAILS = Number(config.loginMaxFails || 8);
const LOGIN_WINDOW_MS = Number(config.loginWindowMs || 600000); // 10 分钟
const loginFails = new Map(); // ip -> number[]（失败时刻）

function loginBucket(ip) {
  const now = Date.now();
  const hits = (loginFails.get(ip) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
  if (hits.length) loginFails.set(ip, hits); else loginFails.delete(ip);
  return hits;
}

function loginBlockedFor(ip) {
  const hits = loginBucket(ip);
  if (hits.length < LOGIN_MAX_FAILS) return 0;
  // 要等最早那次失败滑出窗口，才恢复一次机会
  return Math.max(0, LOGIN_WINDOW_MS - (Date.now() - hits[0]));
}

function noteLoginFail(ip) {
  const hits = loginBucket(ip);
  hits.push(Date.now());
  loginFails.set(ip, hits);
}

function readBody(req, limit = 8192) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > limit) { data = data.slice(0, limit); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(data));
  });
}

// ── 管理页 ──────────────────────────────────────────────────────────────
//
// 单文件、零依赖、原生 JS。不是不想用框架，是这东西要能在一个被 WMI 拉起来、
// 没有构建步骤、断网也能跑的单文件进程里活着。
//
// 路径处理是这个页面最容易出错的地方：tailscale serve 会把 /super 前缀**剥掉**
// 再转发（实测：/super/nonexistent 拿到的是本进程的 404 JSON），所以服务端只看到
// '/'，不知道自己挂在哪个前缀下。浏览器侧的 relative 解析又依赖末尾斜杠 ——
// 访问 /super（无斜杠）时，fetch('services') 会解析到 https://host/services，
// 打到**别的服务**上去。所以页面用 JS 从 location.pathname 反推 base 并补上斜杠，
// 让 /super 和 /super/ 两种访问方式都对。
const LOGIN_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0b0d0f">
<title>supervisord-center 登录</title>
<style>
 /* 配色与列表页共用同一套变量，两个页面看起来才是一套东西。
    这里同样只有两个色相：绿（在线）和琥珀（需注意），其余是灰阶。 */
 :root{
   color-scheme:dark;
   --bg:#0b0d0f; --surface:#121517;
   --line:#23282c; --line-2:#30363b;
   --text:#e9ecef; --text-2:#98a1a9; --text-3:#6a727a;
   --ok:#3ddc97; --warn:#f5b544;
   --mono:ui-monospace,"Cascadia Mono","SF Mono",Consolas,monospace;
 }
 *{box-sizing:border-box}
 html,body{margin:0}
 body{
   min-height:100vh;min-height:100dvh;
   background:var(--bg);color:var(--text);
   display:grid;place-items:center;padding:20px;
   padding-bottom:max(20px,env(safe-area-inset-bottom));
   font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
   -webkit-font-smoothing:antialiased;
   -webkit-tap-highlight-color:transparent;
 }
 .login-wrap{
   width:min(100%,344px);background:var(--surface);border:1px solid var(--line);
   border-radius:14px;padding:24px;
   box-shadow:0 24px 48px -28px #000;
 }
 .brand{display:flex;align-items:center;gap:9px;margin-bottom:24px}
 /* 品牌标记复用列表页的状态点语言：实心 + 外圈微光 */
 .mark{
   width:8px;height:8px;border-radius:50%;flex:none;
   background:var(--ok);box-shadow:0 0 0 3px #3ddc971f;
 }
 .brand b{font:600 12px/1.4 var(--mono);letter-spacing:.04em;color:var(--text-2)}
 label{display:block;font-size:12px;color:var(--text-3);margin-bottom:7px}
 input{
   width:100%;padding:12px 13px;border-radius:9px;
   border:1px solid var(--line-2);background:var(--bg);color:var(--text);
   font:14px/1.4 var(--mono);
   transition:border-color .15s ease,box-shadow .15s ease;
 }
 input::placeholder{color:var(--text-3)}
 input:focus-visible{outline:none;border-color:var(--text-2);box-shadow:0 0 0 3px #ffffff0f}
 /* 按钮不填充琥珀：状态才是主角，操作不该压过它。
    这里是页面唯一的动作，用亮灰填充即可区分主次。 */
 button{
   width:100%;margin-top:8px;padding:12px;border:0;border-radius:9px;
   background:var(--text);color:#0b0d0f;
   font:600 14px/1.4 system-ui,sans-serif;
   cursor:pointer;touch-action:manipulation;
   transition:opacity .15s ease;
 }
 button:hover:not(:disabled){opacity:.88}
 button:active:not(:disabled){transform:translateY(.5px)}
 button:disabled{opacity:.4;cursor:default}
 button:focus-visible{outline:2px solid var(--text-2);outline-offset:2px}
 /* 错误用琥珀而非红：这是「输入不对」，不是系统故障。
    红在这套配色里没有位置 —— 它意味着灾难，而输错一次令牌不是。 */
 .err{color:var(--warn);font-size:12.5px;margin:12px 0 0;min-height:1.2em}
 @media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
</style></head><body>
<!-- 刻意不自动聚焦：手机上会在加载瞬间弹出键盘盖住半屏。只有一个字段，点一下不碍事。 -->
<form class="login-wrap" id="f" method="POST" action="">
  <div class="brand"><span class="mark" aria-hidden="true"></span><b>supervisord-center</b></div>
  <label for="t">访问令牌</label>
  <input type="password" name="token" id="t" placeholder="粘贴令牌"
         autocomplete="current-password" autocapitalize="off" spellcheck="false">
  <button type="submit">进入</button>
  <p class="err" id="e" role="alert"></p>
</form>
<script>
// 用 fetch 提交而不是原生表单 POST：这样错误能就地显示，不用跳转。
// action 保持 ""，因此无论挂在 /super 还是 /super/ 都提交到当前地址，
// 由服务端把 POST / 当作登录处理。
document.getElementById('f').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const e = document.getElementById('e');
  const btn = ev.target.querySelector('button');
  e.textContent = '';
  btn.disabled = true;
  try {
    const r = await fetch('', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'token=' + encodeURIComponent(document.getElementById('t').value),
    });
    if (r.ok) { location.reload(); return; }
    // 服务端会给出可读原因（含限流剩余时间与剩余尝试次数），
    // 直接用它的 message —— 否则「没反应」会被当成页面坏了。
    let msg = '';
    try { msg = (await r.json()).message || ''; } catch {}
    if (msg) { e.textContent = msg; }
    else if (r.status === 429) { e.textContent = '尝试次数过多，请稍后再试'; }
    else if (r.status === 401) { e.textContent = '令牌不正确'; }
    else { e.textContent = '失败：HTTP ' + r.status; }
  } catch (err) {
    e.textContent = '请求失败：' + err.message;
  } finally {
    btn.disabled = false;
  }
});
</script></body></html>`;

const PAGE_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0b0d0f">
<title>supervisord-center</title>
<style>
 /* ── 配色：两个色相，仅此而已 ──────────────────────────────
    上一版有六个色相在抢注意力：蓝色链接、亮琥珀主按钮、绿色开关、
    绿/琥珀/红三种灯、红色 HTTP 标签。结果是「没有一个东西突出」。

    这一版只保留两个色相，各自只承担一个语义：
      绿 = 在线（唯一的「好」），琥珀 = 需注意（唯一的「异常」）
    其余全部是无彩度的灰阶。具体地：
      · 链接不再用蓝色 —— 它只是次要信息，用中性色 +  hover 下划线
      · 离线不再用红色 —— 红色意味着「故障」，而没开只是没开
      · 主按钮不再填充亮色 —— 状态才是主角，操作不该压过它 */
 :root{
   color-scheme:dark;
   --bg:#0b0d0f;
   --surface:#121517;
   --surface-2:#171b1e;
   --line:#23282c;
   --line-2:#30363b;
   --text:#e9ecef;
   --text-2:#98a1a9;
   --text-3:#6a727a;
   --ok:#3ddc97;
   --warn:#f5b544;
   --mono:ui-monospace,"Cascadia Mono","SF Mono",Consolas,monospace;
   --r:10px;
 }
 *{box-sizing:border-box}
 html{-webkit-text-size-adjust:100%}
 body{
   margin:0 auto;max-width:1080px;padding:28px 20px 64px;
   padding-left:max(20px,env(safe-area-inset-left));
   padding-right:max(20px,env(safe-area-inset-right));
   padding-bottom:max(64px,env(safe-area-inset-bottom));
   background:var(--bg);color:var(--text);
   font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
   -webkit-font-smoothing:antialiased;
   -webkit-tap-highlight-color:transparent;
 }

 /* ── 顶栏 ───────────────────────────────────────────────────
    品牌名压到最小：用户知道自己在哪个页面，不需要每次都被提醒。
    真正该一眼看到的，是右边那排状态。 */
 header{display:flex;align-items:flex-start;gap:20px;flex-wrap:wrap;margin-bottom:20px}
 .brand{min-width:0;flex:1 1 auto}
 .brand b{display:block;font:600 12px/1.4 var(--mono);letter-spacing:.04em;
          color:var(--text-2);text-transform:lowercase}
 .brand .host{display:block;font:400 12px/1.5 var(--mono);color:var(--text-3);
              overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
 .fleet{display:flex;align-items:center;gap:9px;flex:none;padding-top:1px}
 .fleet .dots{display:flex;gap:5px}
 .fleet .dots i{width:7px;height:7px;border-radius:50%;flex:none;
                background:transparent;box-shadow:inset 0 0 0 1.5px var(--line-2);
                transition:background-color .25s ease,box-shadow .25s ease}
 .fleet .dots i[data-state="on"]{background:var(--ok);box-shadow:0 0 0 2.5px #3ddc971f}
 .fleet .dots i[data-state="warn"]{background:var(--warn);box-shadow:0 0 0 2.5px #f5b5441f}
 .fleet .count{font:600 12px/1 var(--mono);font-variant-numeric:tabular-nums;
               color:var(--text-2);letter-spacing:.02em}

 /* ── 工具条 ─────────────────────────────────────────────────
    全部是「安静」的按钮：无填充、无强调色。批量启动是低频操作，
    它不该比服务状态更显眼。 */
 .bar{display:flex;align-items:center;gap:8px;margin-bottom:16px;flex-wrap:wrap}
 .bar .spacer{flex:1 1 auto}
 button{
   padding:7px 12px;border-radius:8px;border:1px solid var(--line);
   background:transparent;color:var(--text-2);
   font:500 12.5px/1.35 system-ui,sans-serif;cursor:pointer;
   touch-action:manipulation;white-space:nowrap;
   transition:color .14s ease,border-color .14s ease,background-color .14s ease;
 }
 button:hover:not(:disabled){color:var(--text);border-color:var(--line-2);
                             background:#ffffff08}
 button:active:not(:disabled){transform:translateY(.5px)}
 button:disabled{opacity:.3;cursor:default}
 button:focus-visible{outline:2px solid var(--text-2);outline-offset:2px}
 .icon-btn{padding:7px 10px;font-size:14px;line-height:1.35}

 /* 自动刷新开关：开启时用中性亮灰而不是绿色 —— 它是个设置，
   不是状态，不该跟服务指示灯抢同一个语义。 */
 .tgl{display:inline-flex;align-items:center;gap:8px;font-size:12.5px;
      color:var(--text-3);cursor:pointer;user-select:none;
      transition:color .14s ease}
 .tgl:hover{color:var(--text-2)}
 .tgl input{position:absolute;opacity:0;width:0;height:0}
 .tgl .sw{width:32px;height:18px;border-radius:99px;background:var(--surface-2);
          box-shadow:inset 0 0 0 1px var(--line);position:relative;flex:none;
          transition:background-color .18s ease,box-shadow .18s ease}
 .tgl .sw::after{content:"";position:absolute;top:3px;left:3px;width:12px;height:12px;
                 border-radius:50%;background:var(--text-3);
                 transition:transform .18s ease,background-color .18s ease}
 .tgl input:checked~.sw{background:#2a3035;box-shadow:inset 0 0 0 1px var(--line-2)}
 .tgl input:checked~.sw::after{transform:translateX(14px);background:var(--text)}
 .tgl input:checked~.sw+.lbl{color:var(--text-2)}
 .tgl input:focus-visible~.sw{outline:2px solid var(--text-2);outline-offset:2px}

 /* ── 提示条 ─────────────────────────────────────────────────
    平时完全不占位（:empty 时无内边距无背景），避免常驻一条空框。 */
 #msg{margin:0;font-size:13px;color:var(--text-2)}
 #msg:not(:empty){margin:0 0 16px;padding:10px 13px;border-radius:var(--r);
                  background:var(--surface);border:1px solid var(--line)}
 #msg[data-tone="bad"]{border-color:#5a3a1a;background:#1c1610;color:#f0c88a}
 #msg[data-tone="good"]{border-color:#1f4636;background:#0f1a16;color:#a5e5c8}

 /* ── 服务清单 ───────────────────────────────────────────────
    没有表头。端口和 PID 各自带一个极小的大写标签，于是：
       · 不用表头也能读懂（窄屏藏表头的老问题直接消失了）
       · 少一整行视觉噪音
    用 ul/li 而非 table —— 给 tr/td 套 grid 会让读屏软件丢掉表格语义。 */
 .panel{background:var(--surface);border:1px solid var(--line);
        border-radius:14px;overflow:hidden}
 .rows{list-style:none;margin:0;padding:0}
 .row{
   display:grid;align-items:center;gap:18px;
   grid-template-columns:8px minmax(0,1fr) auto auto;
   grid-template-areas:"dot id meta acts";
   padding:15px 18px;border-bottom:1px solid var(--line);
   transition:background-color .14s ease;
 }
 .row:last-child{border-bottom:0}
 .row:hover{background:#ffffff05}
 .row[data-state="off"] .name,.row[data-state="off"] .meta{opacity:.62}

 /* 状态点：在线实心、异常琥珀、离线只有一圈中性描边。
    颜色之外还有「实心/空心」的形状差异，色觉障碍下同样分得清。 */
 .dot{grid-area:dot;width:8px;height:8px;border-radius:50%;flex:none;
      background:transparent;box-shadow:inset 0 0 0 1.5px var(--line-2);
      transition:background-color .25s ease,box-shadow .25s ease}
 .dot[data-state="on"]{background:var(--ok);box-shadow:0 0 0 3px #3ddc971f}
 .dot[data-state="warn"]{background:var(--warn);box-shadow:0 0 0 3px #f5b5441f}

 .id{grid-area:id;min-width:0}
 .name-line{display:flex;align-items:center;gap:8px;min-width:0}
 .name{font-weight:550;font-size:14.5px;letter-spacing:-.005em;
       overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .tag{font:600 9.5px/1 var(--mono);letter-spacing:.06em;color:var(--text-3);
      border:1px solid var(--line-2);border-radius:4px;padding:3px 4px;flex:none}
 .sub{display:flex;align-items:center;gap:7px;margin-top:3px;
      font-size:12.5px;color:var(--text-3);min-width:0}
 .state{flex:none}
 .state[data-state="on"]{color:var(--ok)}
 .state[data-state="warn"]{color:var(--warn)}
 .state[data-state="off"]{color:var(--text-3)}
 .sep{color:var(--line-2);flex:none}
 .code{font:500 12px/1 var(--mono);color:var(--warn);flex:none}
 /* 链接不用蓝色：它只是「可以点」，不是「需要注意」 */
 .path{color:var(--text-2);text-decoration:none;font:12.5px/1 var(--mono);
       overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
       border-bottom:1px solid transparent;transition:color .14s ease,border-color .14s ease}
 a.path:hover{color:var(--text);border-bottom-color:var(--line-2)}
 .path.dead{color:var(--text-3);cursor:default}

 .meta{grid-area:meta;display:flex;gap:18px;align-items:baseline;flex:none}
 .kv{display:flex;align-items:baseline;gap:6px}
 .k{font:500 9.5px/1 var(--mono);letter-spacing:.07em;color:var(--text-3);
    text-transform:uppercase}
 .v{font:500 12.5px/1 var(--mono);font-variant-numeric:tabular-nums;
    color:var(--text-2);min-width:3.2em;text-align:right}
 .v[data-empty]{opacity:.35}

 .acts{grid-area:acts;display:flex;gap:6px;justify-content:flex-end;flex:none}
 .acts button{padding:6px 11px;font-size:12px}
 .spin{display:inline-block;width:13px;height:13px;border:1.5px solid var(--line-2);
       border-top-color:var(--text-2);border-radius:50%;animation:s .7s linear infinite}
 @keyframes s{to{transform:rotate(360deg)}}
 .empty{padding:34px 18px;text-align:center;color:var(--text-3);font-size:13px}
 /* 首屏点亮：只放一次，之后每 5 秒的刷新不再重放 —— 否则会一直闪。 */
 .boot .row{animation:rise .28s ease backwards}
 @keyframes rise{from{opacity:0;transform:translateY(3px)}}
 .vh{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
     clip:rect(0 0 0 0);white-space:nowrap;border:0}

 /* ── 窄屏：状态与名字一行，元信息与操作各占一行 ───────────── */
 @media (max-width:640px){
   body{padding:20px 14px 48px;
        padding-bottom:max(48px,env(safe-area-inset-bottom))}
   .row{
     grid-template-columns:8px minmax(0,1fr);
     grid-template-areas:"dot id" ". meta" ". acts";
     gap:11px 14px;padding:15px 16px;
   }
   .meta{gap:22px}
   .v{text-align:left;min-width:0}
   /* 手机上按钮要够大才点得中；同时拉满整行，指头不用瞄 */
   .acts{justify-content:stretch;gap:7px;margin-top:1px}
   .acts button{flex:1;min-height:42px;padding:11px 4px;font-size:12.5px;
                border-color:var(--line-2)}
   .bar button{min-height:40px;padding:10px 13px}
   .tgl{margin-left:0}
 }
 @media (prefers-reduced-motion:reduce){
   *{transition:none!important;animation:none!important}
 }
</style></head><body>
<h1 class="vh">服务控制台</h1>

<header>
  <div class="brand">
    <b translate="no">supervisord-center</b>
    <span class="host" id="host" translate="no"></span>
  </div>
  <div class="fleet">
    <span class="dots" id="dots" aria-hidden="true"></span>
    <span class="count" id="count" aria-live="polite"></span>
  </div>
</header>

<p id="msg" role="status" aria-live="polite"></p>

<div class="bar">
  <button id="startAll">全部启动</button>
  <button class="icon-btn" id="refresh" aria-label="刷新" title="刷新">&#8635;</button>
  <span class="spacer"></span>
  <label class="tgl"><input type="checkbox" id="auto" checked><span class="sw"></span><span class="lbl">自动刷新</span></label>
</div>

<main class="panel">
  <ul class="rows" id="rows"></ul>
</main>

<script>
const BASE = location.pathname.endsWith('/') ? location.pathname : location.pathname + '/';
const $ = (id) => document.getElementById(id);
let booted = false;

async function api(rel, opts) {
  const r = await fetch(BASE + rel, { credentials: 'same-origin', ...(opts || {}) });
  if (r.status === 401) { location.reload(); throw new Error('未授权'); }
  const text = await r.text();
  try { return JSON.parse(text); } catch { throw new Error('响应不是 JSON：' + text.slice(0, 120)); }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 三种状态。注意「离线」不是故障，只是没开，所以它没有颜色。
function stateOf(s) {
  if (!s.running) return 'off';
  if (s.http && s.http.status && !s.http.ok) return 'warn';
  return 'on';
}
const STATE_TEXT = { on: '在线', off: '已停止', warn: '异常' };

// 从完整地址里截出路径部分。用 indexOf 找 '//' 而不是正则 ——
// 页面禁止出现反斜杠（会破坏 JS 模板字面量），用字符串切片绕开。
function pathOf(url) {
  if (!url) return '';
  const i = url.indexOf('//');
  const j = i < 0 ? -1 : url.indexOf('/', i + 2);
  return j < 0 ? '/' : url.slice(j);
}

function rowHtml(s, busy, idx) {
  const st = stateOf(s);
  const full = s.tailnetUrl || s.localUrl || '';

  // 只显示路径：每行都重复同一个主机名纯属噪音，主机名在顶上说过一次了。
  // 完整地址放在 title 和 href 里，悬停或点开都能拿到。
  const label = pathOf(s.tailnetUrl) || pathOf(full) || '—';
  const href = s.tailnetUrl
    ? '<a class="path" href="' + esc(s.tailnetUrl) + '" target="_blank" rel="noopener" title="' + esc(s.tailnetUrl) + '">' + esc(label) + '</a>'
    : '<span class="path dead" title="' + esc(full) + '">' + esc(label) + '</span>';

  // HTTP 码只在**不正常**时出现。健康的 200 是废话。
  const code = (st === 'warn' && s.http && s.http.status)
    ? '<span class="sep">·</span><span class="code">HTTP ' + esc(s.http.status) + '</span>' : '';
  const pathBit = s.tailnetUrl ? '<span class="sep">·</span>' + href : '';

  const acts = busy
    ? '<span class="spin" role="img" aria-label="处理中"></span>'
    : '<button data-act="start" data-id="' + esc(s.id) + '"' + (s.running ? ' disabled' : '') + '>启动</button>' +
      '<button data-act="restart" data-id="' + esc(s.id) + '">重启</button>' +
      '<button data-act="stop" data-id="' + esc(s.id) + '"' + (s.running ? '' : ' disabled') + '>停止</button>';

  return '<li class="row" data-state="' + st + '"' + (booted ? '' : ' style="animation-delay:' + Math.min(idx * 40, 320) + 'ms"') + '>' +
    '<span class="dot" data-state="' + st + '" role="img" aria-label="' + STATE_TEXT[st] + '"></span>' +
    '<div class="id">' +
      '<div class="name-line"><span class="name" title="' + esc(s.name) + '">' + esc(s.name) + '</span>' +
        (s.autostart ? '<span class="tag">自启</span>' : '') + '</div>' +
      '<div class="sub"><span class="state" data-state="' + st + '">' + STATE_TEXT[st] + '</span>' +
        code + pathBit + '</div>' +
    '</div>' +
    '<div class="meta">' +
      '<span class="kv"><span class="k">端口</span><span class="v"' + (s.port ? '' : ' data-empty') + '>' + esc(s.port || '—') + '</span></span>' +
      '<span class="kv"><span class="k">PID</span><span class="v"' + (s.pid ? '' : ' data-empty') + '>' + esc(s.pid || '—') + '</span></span>' +
    '</div>' +
    '<div class="acts">' + acts + '</div></li>';
}

let busy = {};
let services = [];

function render() {
  const rows = $('rows');
  if (!services.length) {
    rows.innerHTML = '<li class="empty">没有配置任何服务</li>';
  } else {
    rows.innerHTML = services.map((s, i) => rowHtml(s, !!busy[s.id], i)).join('');
  }
  // 舰队视图：和列表同源，只是压缩成一行，用来「一眼扫完全部」
  $('dots').innerHTML = services.map((s) =>
    '<i data-state="' + stateOf(s) + '"></i>').join('');
  const on = services.filter((s) => s.running).length;
  $('count').textContent = on + '/' + services.length;
  $('count').setAttribute('aria-label', services.length + ' 个服务，' + on + ' 个在线');
  if (!booted && services.length) {
    document.querySelector('.panel').classList.add('boot');
    booted = true;
    setTimeout(() => document.querySelector('.panel').classList.remove('boot'), 1100);
  }
}

function say(text, tone) {
  const m = $('msg');
  m.textContent = text || '';
  if (tone) m.setAttribute('data-tone', tone); else m.removeAttribute('data-tone');
}

async function load() {
  const data = await api('services');
  services = data.services || [];
  render();
  const first = services.find((s) => s.tailnetUrl);
  const host = $('host');
  if (first) {
    const u = first.tailnetUrl;
    const i = u.indexOf('//');
    const j = i < 0 ? -1 : u.indexOf('/', i + 2);
    host.textContent = j < 0 ? u.slice(i + 2) : u.slice(i + 2, j);
  } else {
    host.textContent = '';
  }
}

async function act(id, what) {
  busy[id] = true; render(); say('');
  try {
    const r = await api('services/' + encodeURIComponent(id) + '/' + what, { method: 'POST' });
    // 失败要说清「哪个 + 为什么」，只报「失败」等于没说
    if (r.ok === false) say(id + ' ' + what + ' 失败：' + (r.message || r.error || '未知'), 'bad');
    else if (what === 'start' && r.alreadyRunning) say(id + ' 本来就在运行');
    else if (what === 'start' && r.listening === false) say(id + ' 已拉起，端口还没就绪', 'bad');
    else if (r.stillRunning) say(id + ' 停止后仍在监听（自愈包装器可能又拉起来了）', 'bad');
    else say(id + ' ' + ({ start: '已启动', restart: '已重启', stop: '已停止' }[what] || what), 'good');
  } catch (e) {
    say('失败：' + e.message, 'bad');
  } finally {
    delete busy[id]; render();
    if (auto.checked) setTimeout(() => load().catch(() => {}), 400);
  }
}

$('rows').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-act]');
  if (b) act(b.dataset.id, b.dataset.act);
});
$('refresh').addEventListener('click', () => { say(''); load().catch((e) => say(e.message, 'bad')); });
$('startAll').addEventListener('click', async () => {
  // 只拉离线的：对已在跑的服务发一堆幂等请求纯属噪音
  const down = services.filter((x) => !x.running);
  if (!down.length) { say('全部在线'); return; }
  $('startAll').disabled = true;
  try { for (const s of down) await act(s.id, 'start'); }
  finally { $('startAll').disabled = false; }
  load().catch(() => {});
});
const auto = $('auto');
setInterval(() => {
  if (auto.checked && !Object.keys(busy).length) load().catch(() => {});
}, 5000);
auto.addEventListener('change', () => { if (auto.checked) load().catch(() => {}); });
load().catch((e) => say(e.message, 'bad'));
</script></body></html>`;

// ── HTTP ────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const route = url.pathname.replace(/\/+$/, '') || '/';

  // 登录必须放在鉴权之前，否则没法登录。它自己校验 body 里的 token。
  if (req.method === 'POST' && (route === '/' || route === '/login')) {
    const ip = req.socket.remoteAddress || '?';
    const waitMs = loginBlockedFor(ip);
    if (waitMs > 0) {
      const mins = Math.ceil(waitMs / 60000);
      log('429 POST /login from ' + ip + ' (rate limited, ' + mins + ' min left)');
      res.writeHead(429, {
        'content-type': 'application/json; charset=utf-8',
        'retry-after': String(Math.ceil(waitMs / 1000)),
        'cache-control': 'no-store',
      });
      // 明确告诉用户还要等多久 —— 否则「登录页没反应」会被当成坏了
      return res.end(JSON.stringify({
        ok: false, error: 'too-many-attempts',
        message: '尝试次数过多，请 ' + mins + ' 分钟后再试',
        retryAfterSec: Math.ceil(waitMs / 1000),
      }));
    }

    const body = await readBody(req);
    const params = new URLSearchParams(body);
    const given = params.get('token') || '';
    if (!timingSafeEq(given, TOKEN)) {
      noteLoginFail(ip);
      const left = Math.max(0, LOGIN_MAX_FAILS - loginBucket(ip).length);
      log('401 POST /login from ' + ip + ' (' + left + ' attempts left)');
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({
        ok: false, error: 'unauthorized',
        // 剩余次数只在快用完时才提示，避免帮攻击者确认「猜对了格式」
        message: left <= 3 ? ('令牌不正确，还可尝试 ' + left + ' 次') : '令牌不正确',
      }));
    }
    loginFails.delete(ip); // 成功即清空，避免正常使用累积到被锁
    // HttpOnly：页面脚本读不到它，XSS 也偷不走。
    // SameSite=Lax：够用且不影响经代理的正常导航。
    // 不设 Secure：反向代理侧可能是 HTTPS，但 loopback 直连是 HTTP，设了会让
    // http://127.0.0.1:<port> 的本地登录失效。若你只经 HTTPS 访问，可以打开它。
    res.writeHead(204, {
      'set-cookie': 'sdc_session=' + sessionValue() + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000',
      'cache-control': 'no-store',
    });
    log('login ok from ' + ip);
    return res.end();
  }

  if (!authorized(req)) {
    // 浏览器导航（Accept 带 text/html）给登录页，API 调用给 401 JSON。
    // 否则在手机上打开 /super 只会看到一行 {"error":"unauthorized"}，没人知道该干嘛。
    const wantsHtml = req.method === 'GET' && String(req.headers.accept || '').includes('text/html');
    if (wantsHtml && (route === '/' || route === '/ui')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(LOGIN_HTML);
    }
    log('401 ' + req.method + ' ' + route + ' from ' + (req.socket.remoteAddress || '?'));
    return json(res, 401, { ok: false, error: 'unauthorized' });
  }

  try {
    // 管理页。带 Cookie 的浏览器走到这里。
    if (req.method === 'GET' && (route === '/' || route === '/ui')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(PAGE_HTML);
    }

    if (req.method === 'GET' && (route === '/health' || route === '/super' || route === '/status')) {
      return json(res, 200, { ok: true, ...(await status()) });
    }

    if (req.method === 'GET' && route === '/services') {
      return json(res, 200, {
        ok: true,
        centerPort: PORT,
        centerPid: process.pid,
        uptimeSec: Math.round(process.uptime()),
        configPath: CONFIG_PATH,
        defaultService: DEFAULT_SERVICE_ID,
        services: await allStatus(),
      });
    }

    // 旧接口：指向默认服务，保持 App 兼容
    if (req.method === 'POST' && (route === '/start' || route === '/restart')) {
      const svc = serviceById(DEFAULT_SERVICE_ID) || SERVICES[0];
      const r = route === '/start' ? await startService(svc) : await restartService(svc);
      return json(res, r.ok === false ? (r.status || 500) : 200, r);
    }

    // 多服务接口：/services/<id>/<动作>
    const m = route.match(/^\/services\/([^/]+)\/(start|stop|restart)$/);
    if (req.method === 'POST' && m) {
      const svc = serviceById(decodeURIComponent(m[1]));
      if (!svc) return json(res, 404, { ok: false, error: 'no-such-service', id: decodeURIComponent(m[1]) });
      const r = m[2] === 'start' ? await startService(svc)
        : m[2] === 'stop' ? await stopService(svc)
          : await restartService(svc);
      return json(res, r.ok === false ? (r.status || 500) : 200, r);
    }

    if (req.method === 'GET' && route === '/services/status') {
      return json(res, 200, { ok: true, services: await allStatus() });
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
  log('listening on ' + HOST + ':' + PORT + ' pid=' + process.pid + ' ppid=' + process.ppid +
    ' config=' + CONFIG_PATH + ' services=' + SERVICES.map((s) => s.id + ':' + s.port).join(','));
  // autostart：只拉不动的。这里刻意延迟几秒 —— 登录瞬间一堆东西同时抢 IO，
  // 而且别的服务可能正因为登录自启而正在启动中。
  const wanted = SERVICES.filter((s) => s.autostart);
  if (wanted.length) {
    setTimeout(async () => {
      for (const svc of wanted) {
        try {
          const r = await startService(svc);
          log('[autostart] ' + svc.id + ' -> ' + JSON.stringify({ started: r.started, alreadyRunning: r.alreadyRunning, listening: r.listening }));
        } catch (error) {
          log('[autostart] ' + svc.id + ' 失败：' + (error && error.message ? error.message : error));
        }
      }
    }, 6000);
  }
});

// 兜底：kill(0) 杀整个进程组（含自己）。实测发生过，显式拦一道。
const _kill = process.kill.bind(process);
process.kill = (pid, signal) => {
  if (pid === 0) {
    log('拦截了一次 process.kill(0)：它会杀掉本进程自己，已忽略');
    return false;
  }
  return _kill(pid, signal);
};

// 本进程绝不能因为未捕获异常而悄悄死掉 —— 死了就没人能远程救被托管服务了
process.on('uncaughtException', (e) => log('uncaughtException：' + (e && e.stack ? e.stack : e)));
process.on('unhandledRejection', (e) => log('unhandledRejection：' + (e && e.stack ? e.stack : e)));
