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
 *  1. 只监听 127.0.0.1。Windows 防火墙规则改动要管理员，而本机用户不是管理员。
 *     外网可达性交给 tailscale serve（跑在 Tailscale 服务里，本来就有权限）：
 *       tailscale serve --bg --https=443 --set-path=/super http://127.0.0.1:3099
 *     实测非管理员可执行，且不影响原有的 / 到 3080 的映射。
 *  2. 不能由被托管的 dsh 工具子进程直接 spawn。dsh 用 Windows Job Object 并在
 *     关闭时连带杀子进程，detached:true 也逃不掉（DETACHED_PROCESS 不解除 Job
 *     成员身份）。必须经 WMI（Win32_Process.Create）创建，父进程变成
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
// 刻意**不放在 ~/.dsh 下**。这是「完全独立」的一部分：本进程托管 dsh web，
// 但它的生命周期、配置、日志都不该跟 dsh 的目录纠缠 —— dsh 被卸载/重装/
// 换 HOME 都不该影响这里，反过来也一样。
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
// 启动后等端口就绪的上限。dsh 冷启动要十几秒，别的服务几秒就够，
// 用同一个上限是为了避免「每个服务一个魔数」。
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
        // 显式传 cwd：否则被托管服务会以本进程的目录为工作区（实测过，dsh 的
        // workspaceRoot 取自 process.cwd()，传错会导致工作区跑到 supervisor 目录）。
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
// 打到 DSH 上去。所以页面用 JS 从 location.pathname 反推 base 并补上斜杠，
// 让 /super 和 /super/ 两种访问方式都对。
const LOGIN_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>supervisord-center 登录</title>
<style>
 body{font:15px/1.6 system-ui,"Segoe UI",sans-serif;background:#111417;color:#e6e6e6;
      display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
 .box{background:#1a1f24;padding:28px 30px;border-radius:12px;width:min(92vw,380px);
      border:1px solid #2b3238}
 h1{font-size:17px;margin:0 0 4px}
 p{color:#8b949e;font-size:13px;margin:0 0 18px}
 input{width:100%;box-sizing:border-box;padding:11px 12px;border-radius:8px;
       border:1px solid #30363d;background:#0d1117;color:#e6e6e6;font-size:14px}
 button{width:100%;margin-top:12px;padding:11px;border:0;border-radius:8px;
        background:#2f81f7;color:#fff;font-size:14px;font-weight:600;cursor:pointer}
 button:hover{background:#4a92f8}
 .err{color:#f85149;font-size:13px;margin-top:10px;min-height:18px}
 code{background:#0d1117;padding:2px 5px;border-radius:4px;font-size:12px}
</style></head><body>
<form class="box" id="f" method="POST" action="">
  <h1>supervisord-center</h1>
  <p>服务托管中枢 · 需要访问令牌</p>
  <input type="password" name="token" id="t" placeholder="token" autocomplete="current-password" autofocus>
  <button type="submit">进入</button>
  <div class="err" id="e"></div>
</form>
<script>
// 用 fetch 提交而不是原生表单 POST：这样错误能就地显示，不用跳转。
// action 保持 ""，因此无论挂在 /super 还是 /super/ 都提交到当前地址，
// 由服务端把 POST / 当作登录处理。
document.getElementById('f').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const e = document.getElementById('e');
  e.textContent = '';
  try {
    const r = await fetch('', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'token=' + encodeURIComponent(document.getElementById('t').value),
    });
    if (r.ok) { location.reload(); return; }
    e.textContent = r.status === 401 ? '令牌不正确' : ('失败：HTTP ' + r.status);
  } catch (err) { e.textContent = '请求失败：' + err.message; }
});
</script></body></html>`;

const PAGE_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>supervisord-center</title>
<style>
 :root{color-scheme:dark}
 body{font:15px/1.6 system-ui,"Segoe UI",sans-serif;background:#111417;color:#e6e6e6;margin:0;padding:22px}
 header{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:4px}
 h1{font-size:19px;margin:0}
 .sub{color:#8b949e;font-size:13px}
 .bar{display:flex;gap:10px;align-items:center;margin:14px 0 18px;flex-wrap:wrap}
 button{padding:7px 13px;border-radius:7px;border:1px solid #30363d;background:#21262d;
        color:#e6e6e6;font-size:13px;cursor:pointer}
 button:hover{background:#2d333b}
 button.primary{background:#238636;border-color:#2ea043}
 button.primary:hover{background:#2ea043}
 button:disabled{opacity:.45;cursor:not-allowed}
 table{width:100%;border-collapse:collapse;font-size:14px}
 th,td{text-align:left;padding:11px 10px;border-bottom:1px solid #21262d;vertical-align:middle}
 th{color:#8b949e;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
 tr.off{background:#1a1416}
 .dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px}
 .on{background:#3fb950;box-shadow:0 0 7px #3fb95088}
 .off2{background:#f85149}
 .name{font-weight:600}
 .port{color:#8b949e;font-variant-numeric:tabular-nums}
 a{color:#58a6ff;text-decoration:none}
 a:hover{text-decoration:underline}
 .acts{display:flex;gap:6px;flex-wrap:wrap}
 .muted{color:#6e7681;font-size:12px}
 .spin{display:inline-block;width:11px;height:11px;border:2px solid #8b949e;
       border-top-color:transparent;border-radius:50%;animation:s .7s linear infinite;vertical-align:-1px}
 @keyframes s{to{transform:rotate(360deg)}}
 #msg{font-size:13px;color:#8b949e;min-height:20px}
</style></head><body>
<header>
  <h1>supervisord-center</h1>
  <span class="sub" id="sum">加载中…</span>
</header>
<div class="bar">
  <button class="primary" id="startAll">全部拉起</button>
  <button id="refresh">刷新</button>
  <label class="sub"><input type="checkbox" id="auto" checked> 每 5 秒自动刷新</label>
  <span id="msg"></span>
</div>
<table>
  <thead><tr>
    <th>服务</th><th>状态</th><th>端口</th><th>PID</th><th>地址</th><th>操作</th>
  </tr></thead>
  <tbody id="tb"></tbody>
</table>
<p class="muted" id="foot"></p>
<script>
const BASE = location.pathname.endsWith('/') ? location.pathname : location.pathname + '/';
const $ = (id) => document.getElementById(id);

async function api(rel, opts) {
  const r = await fetch(BASE + rel, { credentials: 'same-origin', ...(opts || {}) });
  if (r.status === 401) { location.reload(); throw new Error('未授权'); }
  const text = await r.text();
  try { return JSON.parse(text); } catch { throw new Error('响应不是 JSON：' + text.slice(0, 120)); }
}

function row(s, busy) {
  const tr = document.createElement('tr');
  if (!s.running) tr.className = 'off';
  const url = s.tailnetUrl
    ? '<a href="' + s.tailnetUrl + '" target="_blank" rel="noopener">' + s.tailnetUrl + '</a>'
    : '<span class="muted">' + (s.localUrl || '—') + '</span>';
  tr.innerHTML =
    '<td><span class="name">' + s.name + '</span>' +
      (s.autostart ? ' <span class="muted">自启</span>' : '') +
      (s.note ? '<div class="muted">' + s.note + '</div>' : '') + '</td>' +
    '<td><span class="dot ' + (s.running ? 'on' : 'off2') + '"></span>' +
      (s.running ? '在线' : '离线') +
      (s.http && s.http.status && !s.http.ok ? ' <span class="muted">HTTP ' + s.http.status + '</span>' : '') + '</td>' +
    '<td class="port">' + (s.port || '—') + '</td>' +
    '<td class="port">' + (s.pid || '—') + '</td>' +
    '<td>' + url + '</td>' +
    '<td><div class="acts">' +
      (busy
        ? '<span class="spin"></span><span class="muted">处理中…</span>'
        : '<button data-act="start" data-id="' + s.id + '"' + (s.running ? ' disabled' : '') + '>启动</button>' +
          '<button data-act="restart" data-id="' + s.id + '">重启</button>' +
          '<button data-act="stop" data-id="' + s.id + '"' + (s.running ? '' : ' disabled') + '>停止</button>') +
    '</div></td>';
  return tr;
}

let busy = {};
let services = [];

function render() {
  const tb = $('tb');
  tb.textContent = '';
  for (const s of services) tb.appendChild(row(s, !!busy[s.id]));
  const on = services.filter((s) => s.running).length;
  $('sum').textContent = on + ' / ' + services.length + ' 在线';
}

async function load() {
  const data = await api('services');
  services = data.services || [];
  render();
  $('foot').textContent = '控制面 ' + (data.centerPort || '') + ' · 运行 ' +
    Math.round(data.uptimeSec || 0) + ' 秒 · 配置 ' + (data.configPath || '');
}

async function act(id, what) {
  busy[id] = true; render();
  $('msg').textContent = '';
  try {
    const r = await api('services/' + encodeURIComponent(id) + '/' + what, { method: 'POST' });
    if (r.ok === false) $('msg').textContent = what + ' ' + id + ' 失败：' + (r.message || r.error || '未知');
    else if (what === 'start' && r.alreadyRunning) $('msg').textContent = id + ' 本来就在运行';
    else if (what === 'start' && r.listening === false) $('msg').textContent = id + ' 已拉起但端口还没就绪，稍后刷新看看';
    else if (r.stillRunning) $('msg').textContent = id + ' 停止后仍在监听（自愈包装器可能把它拉回来了）';
  } catch (e) {
    $('msg').textContent = '失败：' + e.message;
  } finally {
    delete busy[id]; render();
    if (auto.checked) setTimeout(() => load().catch(() => {}), 400);
  }
}

$('tb').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-act]');
  if (b) act(b.dataset.id, b.dataset.act);
});
$('refresh').addEventListener('click', () => load().catch((e) => { $('msg').textContent = e.message; }));
$('startAll').addEventListener('click', async () => {
  // 只拉离线的。全量启动会对着已经在跑的服务发一堆幂等请求，纯属噪音。
  for (const s of services.filter((x) => !x.running)) await act(s.id, 'start');
  load().catch(() => {});
});
const auto = $('auto');
let timer = setInterval(tick, 5000);
function tick() { if (auto.checked && !Object.keys(busy).length) load().catch(() => {}); }
auto.addEventListener('change', () => { if (auto.checked) load().catch(() => {}); });
load().catch((e) => { $('msg').textContent = e.message; });
</script></body></html>`;

// ── HTTP ────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const route = url.pathname.replace(/\/+$/, '') || '/';

  // 登录必须放在鉴权之前，否则没法登录。它自己校验 body 里的 token。
  if (req.method === 'POST' && (route === '/' || route === '/login')) {
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    const given = params.get('token') || '';
    if (!timingSafeEq(given, TOKEN)) {
      log('401 POST /login from ' + (req.socket.remoteAddress || '?'));
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
    }
    // HttpOnly：页面脚本读不到它，XSS 也偷不走。
    // SameSite=Lax：够用且不影响 tailnet 上的正常导航。
    // 不设 Secure：Tailscale 侧是 HTTPS，但 loopback 直连是 HTTP，设了会让
    // http://127.0.0.1:3099 的本地登录失效（和 workbuddy 的 ADMIN_INSECURE_COOKIE
    // 是同一个权衡）。
    res.writeHead(204, {
      'set-cookie': 'sdc_session=' + sessionValue() + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000',
      'cache-control': 'no-store',
    });
    log('login ok from ' + (req.socket.remoteAddress || '?'));
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
