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
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>supervisord-center 登录</title>
<style>
 :root{
   color-scheme:dark;
   --bg:#0b0f14; --face:#121820; --rule:#232c38;
   --text:#dce3ec; --dim:#7b8798; --amber:#e3a008; --dead:#ff5d5d;
 }
 *{box-sizing:border-box}
 html,body{margin:0}
 body{
   min-height:100vh; min-height:100dvh;
   background:radial-gradient(120% 80% at 50% -10%,#16202b 0,transparent 60%),var(--bg);
   color:var(--text); display:grid; place-items:center; padding:20px;
   padding-bottom:max(20px,env(safe-area-inset-bottom));
   font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
   -webkit-tap-highlight-color:transparent;
 }
 .login-wrap{
   width:min(100%,360px); background:var(--face); border:1px solid var(--rule);
   border-radius:14px; padding:22px;
   box-shadow:inset 0 1px 0 #ffffff0a, 0 18px 44px -22px #000;
 }
 .brand{display:flex;align-items:center;gap:9px;margin-bottom:22px}
 /* 复用列表页的「实体指示灯」语言做品牌标记，两页看起来是一套东西 */
 .mark{
   width:11px;height:11px;border-radius:50%;flex:none;
   background:radial-gradient(circle at 34% 28%,#ffffffb0,transparent 55%),var(--amber);
   box-shadow:0 0 0 2px #05080b,0 0 10px 1px #e3a00866;
 }
 .brand b{font-size:15px;font-weight:650;letter-spacing:-.01em}
 label{display:block;font-size:12px;color:var(--dim);margin-bottom:7px}
 input{
   width:100%; padding:12px 13px; border-radius:9px; border:1px solid var(--rule);
   background:#0a0e13; color:var(--text); font:inherit;
   font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;
   transition:border-color .15s ease,box-shadow .15s ease;
 }
 input::placeholder{color:#4d5866}
 input:focus-visible{outline:none;border-color:var(--amber);box-shadow:0 0 0 3px #e3a00838}
 button{
   width:100%; margin-top:14px; padding:13px; border:0; border-radius:9px;
   background:var(--amber); color:#1a1200; font:inherit; font-weight:650;
   cursor:pointer; touch-action:manipulation;
   transition:background-color .15s ease;
 }
 button:hover:not(:disabled){background:#f0ae12}
 button:active:not(:disabled){transform:translateY(1px)}
 button:disabled{opacity:.5;cursor:default}
 button:focus-visible{outline:2px solid var(--amber);outline-offset:2px}
 .err{color:var(--dead);font-size:13px;margin:12px 0 0;min-height:1.2em}
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
<meta name="theme-color" content="#0b0f14">
<title>supervisord-center</title>
<style>
 /* 配色取自机柜/控制台的语汇，不是通用 SaaS 深色主题：
    底板近黑、面板微亮、琥珀作为唯一的「操作/注意」色。 */
 :root{
   color-scheme:dark;
   --bg:#0b0f14; --face:#121820; --sunken:#0a0e13; --rule:#232c38;
   --text:#dce3ec; --dim:#7b8798;
   --live:#3fd07a; --dead:#ff5d5d; --amber:#e3a008;
   --mono:ui-monospace,"Cascadia Mono",Consolas,monospace;
 }
 *{box-sizing:border-box}
 html{-webkit-text-size-adjust:100%}
 body{
   margin:0 auto; max-width:880px; padding:18px;
   padding-left:max(18px,env(safe-area-inset-left));
   padding-right:max(18px,env(safe-area-inset-right));
   padding-bottom:max(18px,env(safe-area-inset-bottom));
   background:var(--bg); color:var(--text);
   font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
   -webkit-tap-highlight-color:transparent;
 }

 /* ── 顶栏：铭牌 + 舰队灯带 ─────────────────────────────────
    灯带是整个页面的论点：一眼扫完所有服务的状态，不用读任何字。
    它不重复列表信息，它是「全部」的那个视角。 */
 header{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px}
 header b{font:650 15px/1 var(--mono);letter-spacing:-.02em}
 /* 主机名只说一次。列表里就只需要显示路径了。 */
 .host{font:12px/1 var(--mono);color:var(--dim);min-width:0;
       overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;max-width:100%}
 .strip{display:flex;gap:6px;align-items:center}
 .strip i{width:10px;height:10px;border-radius:50%;flex:none;
          background:#131a22;box-shadow:0 0 0 1px #2a3440}
 .count{font:600 13px/1 var(--mono);font-variant-numeric:tabular-nums;color:var(--dim)}

 /* ── 指示灯（签名元素）─────────────────────────────────────
    照物理指示灯做：内凹底座 + 高光 + 点亮时外溢的辉光。
    三个状态各自含义不同，且不只靠颜色区分：
      on   = 端口在听              → 亮绿、实心发光
      off  = 端口没听（不是故障）  → 不亮、暗芯 + 暗红圈
      warn = 在听但 HTTP 不健康    → 亮琥珀
    颜色之外还有形状差异，色觉障碍下也分得清。 */
 .lamp{
   width:13px;height:13px;border-radius:50%;flex:none;
   background:#151c25;box-shadow:inset 0 1px 3px #000c,0 0 0 1px #2a3440;
   transition:background-color .2s ease,box-shadow .2s ease;
 }
 .lamp[data-state="on"]{
   background:radial-gradient(circle at 34% 28%,#f2fff8,transparent 58%),var(--live);
   box-shadow:0 0 0 1px #0f4025,0 0 9px 1px #3fd07a99,inset 0 0 3px #ffffffcc;
 }
 .lamp[data-state="off"]{
   background:radial-gradient(circle at 34% 28%,#ffffff26,transparent 58%),#1a1113;
   box-shadow:0 0 0 1px #4a1d1d,inset 0 1px 3px #000c;
 }
 .lamp[data-state="warn"]{
   background:radial-gradient(circle at 34% 28%,#fffaf0,transparent 58%),var(--amber);
   box-shadow:0 0 0 1px #4a3405,0 0 9px 1px #e3a00899,inset 0 0 3px #ffffffcc;
 }
 .strip i[data-state="on"]{background:var(--live);box-shadow:0 0 6px #3fd07a99}
 .strip i[data-state="off"]{background:#241417;box-shadow:0 0 0 1px #4a1d1d}
 .strip i[data-state="warn"]{background:var(--amber);box-shadow:0 0 6px #e3a00899}

 /* ── 提示条 ─────────────────────────────────────────────── */
 #msg{margin:0 0 12px;font-size:13px;color:var(--dim)}
 #msg:not(:empty){padding:9px 12px;border-radius:8px;background:#1a212b;border:1px solid var(--rule)}
 #msg[data-tone="bad"]{color:#ffb4b4;border-color:#4a1d1d;background:#1a1113}
 #msg[data-tone="good"]{color:#a7e8c4;border-color:#1d4a30;background:#0f1a14}

 /* ── 工具条 ─────────────────────────────────────────────── */
 .bar{display:flex;gap:8px;align-items:center;margin-bottom:14px}
 button{
   padding:9px 13px;border-radius:8px;border:1px solid var(--rule);
   background:#1a212b;color:var(--text);font:500 13px/1 system-ui,sans-serif;
   cursor:pointer;touch-action:manipulation;white-space:nowrap;
   transition:background-color .15s ease,border-color .15s ease;
 }
 button:hover:not(:disabled){background:#232c38}
 button:active:not(:disabled){transform:translateY(1px)}
 button:disabled{opacity:.38;cursor:default}
 button:focus-visible{outline:2px solid var(--amber);outline-offset:2px}
 button.primary{background:var(--amber);border-color:#b47f06;color:#1a1200;font-weight:650}
 button.primary:hover:not(:disabled){background:#f0ae12}
 button.icon{padding:9px 12px;font-size:15px;line-height:1}
 /* 自动刷新开关：checkbox 本体视觉隐藏，用 span 画开关。
   label 包着 input，点击区域和控件是同一个，没有死区。 */
 .tgl{display:inline-flex;align-items:center;gap:7px;font-size:13px;color:var(--dim);
      cursor:pointer;user-select:none;margin-left:auto}
 .tgl input{position:absolute;opacity:0;width:0;height:0}
 .tgl .sw{width:34px;height:19px;border-radius:99px;background:#232c38;position:relative;
          transition:background-color .18s ease;flex:none}
 .tgl .sw::after{content:"";position:absolute;top:2px;left:2px;width:15px;height:15px;
                 border-radius:50%;background:#8b96a5;
                 transition:transform .18s ease,background-color .18s ease}
 .tgl input:checked+.sw{background:#1d5c37}
 .tgl input:checked+.sw::after{transform:translateX(15px);background:var(--live)}
 .tgl input:focus-visible+.sw{outline:2px solid var(--amber);outline-offset:2px}

 /* ── 服务清单 ───────────────────────────────────────────────
    同一份 DOM：宽屏排成矩阵，窄屏叠成卡片，靠 grid-template-areas 切换。
    用 ul/li 而不是 table —— 一旦给 tr/td 套 grid，读屏软件就拿不到表格语义了。 */
 .panel{border:1px solid var(--rule);border-radius:11px;overflow:hidden;background:var(--face)}
 .hdr,.row{
   display:grid;align-items:center;gap:10px;
   grid-template-columns:13px minmax(120px,1fr) 44px 56px minmax(56px,auto) auto;
   grid-template-areas:"lamp who port pid path acts";
 }
 .hdr{padding:9px 14px;background:var(--sunken);border-bottom:1px solid var(--rule);
      font-size:11px;color:var(--dim);letter-spacing:.06em;text-transform:uppercase}
 .hdr .c-who{grid-area:who} .hdr .c-port{grid-area:port;text-align:right}
 .hdr .c-pid{grid-area:pid;text-align:right} .hdr .c-path{grid-area:path}
 .hdr .c-acts{grid-area:acts;text-align:right}
 .rows{list-style:none;margin:0;padding:0}
 .row{padding:11px 14px;border-bottom:1px solid var(--rule)}
 .row:last-child{border-bottom:0}
 .row[data-state="off"]{background:#0e1218}
 .lamp{grid-area:lamp}
 .who{grid-area:who;min-width:0;display:flex;align-items:center;gap:7px}
 /* 名字单行截断：让每行等高，扫读时不跳。完整名字放在 title 里 */
 .who b{font-weight:600;font-size:14px;min-width:0;overflow:hidden;
        text-overflow:ellipsis;white-space:nowrap}
 .tag{font:600 9px/1 var(--mono);letter-spacing:.08em;color:var(--dim);
      border:1px solid var(--rule);border-radius:4px;padding:3px 4px;flex:none}
 .tag.bad{color:#ffc9c9;border-color:#5a2323;background:#241315}
 .num{font:13px/1 var(--mono);font-variant-numeric:tabular-nums;color:var(--dim);
      white-space:nowrap;text-align:right}
 .num[data-empty]{opacity:.3}
 .port{grid-area:port} .pid{grid-area:pid}
 .path{grid-area:path;font:13px/1 var(--mono);color:#6cb6ff;text-decoration:none;
       max-width:100%;justify-self:start;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .path:hover{text-decoration:underline}
 .path.dead{color:var(--dim);cursor:default}
 .acts{grid-area:acts;display:flex;gap:6px;justify-content:flex-end}
 .acts button{padding:7px 11px;font-size:12px}
 .spin{display:inline-block;width:12px;height:12px;border:2px solid var(--dim);
       border-top-color:transparent;border-radius:50%;animation:s .7s linear infinite}
 @keyframes s{to{transform:rotate(360deg)}}
 .empty{padding:26px 14px;text-align:center;color:var(--dim);font-size:13px}
 /* 首屏点亮：灯从上到下依次亮起，像控制台通电。
     只做这一次，之后刷新不再重放 —— 每 5 秒闪一次会很烦。 */
 .boot .row{animation:rise .3s ease backwards}
 @keyframes rise{from{opacity:0;transform:translateY(4px)}}
 .vh{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
     clip:rect(0 0 0 0);white-space:nowrap;border:0}

 /* ── 窄屏：矩阵塌成卡片，按钮拉满整行给指头 ───────────────── */
 @media (max-width:640px){
   body{padding:14px;padding-bottom:max(14px,env(safe-area-inset-bottom))}
   .hdr{display:none}
   .row{
     grid-template-columns:13px 1fr;
     grid-template-areas:"lamp who" "nums nums" "path path" "acts acts";
     gap:9px 10px;padding:13px 14px;
   }
   .port{grid-area:nums;text-align:left}
   .pid{grid-area:nums;justify-self:end}
   /* 表头在窄屏被藏了，用伪元素补回字段名，免得两个数字分不清 */
   .port::before{content:"端口 ";opacity:.6}
   .pid::before{content:"PID ";opacity:.6}
   .acts{justify-content:stretch}
   .acts button{flex:1;min-height:40px;padding:10px 4px}
   /* 工具条按钮也拉到 40px：手机上 33px 的按钮点起来发飘 */
   .bar button{min-height:40px;padding:10px 14px}
   .bar button.icon{padding:10px 13px}
   .tgl{margin-left:0}
   .bar{flex-wrap:wrap}
 }
 @media (prefers-reduced-motion:reduce){
   *{transition:none!important;animation:none!important}
 }
</style></head><body>
<h1 class="vh">服务控制台</h1>
<header>
  <b translate="no">supervisord-center</b>
  <span class="host" id="host" translate="no"></span>
  <div class="strip" id="strip" aria-hidden="true"></div>
  <span class="count" id="count" aria-live="polite"></span>
</header>
<p id="msg" role="status" aria-live="polite"></p>
<div class="bar">
  <button class="primary" id="startAll">全部启动</button>
  <button class="icon" id="refresh" aria-label="刷新" title="刷新">⟳</button>
  <label class="tgl"><input type="checkbox" id="auto" checked><span class="sw"></span>自动</label>
</div>
<main class="panel">
  <div class="hdr" aria-hidden="true">
    <span class="c-who">服务</span><span class="c-port">端口</span>
    <span class="c-pid">PID</span><span class="c-path">地址</span>
    <span class="c-acts">操作</span>  </div>
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

// 灯的状态：在线但 HTTP 探针不健康 → warn，其余按 running 二选一。
// 「离线」不是故障，只是没开，所以不点亮、也不喊。
function lampState(s) {
  if (!s.running) return 'off';
  if (s.http && s.http.status && !s.http.ok) return 'warn';
  return 'on';
}
const STATE_TEXT = { on: '在线', off: '离线', warn: '在线但 HTTP 异常' };

function rowHtml(s, busy, idx) {
  const st = lampState(s);
  const full = s.tailnetUrl || s.localUrl || '';
  // 只显示路径：每一行都重复同一个主机名纯属噪音，主机名在标题里说明一次就够了。
  // 完整地址放进 title 和 href，悬停或点开都能拿到。（绕开正则，避免反斜杠）
  let label = full;
  if (s.tailnetUrl) {
    const i = s.tailnetUrl.indexOf('//');
    const j = i < 0 ? -1 : s.tailnetUrl.indexOf('/', i + 2);
    label = j < 0 ? '/' : s.tailnetUrl.slice(j);
  }
  const href = s.tailnetUrl
    ? '<a class="path" href="' + esc(s.tailnetUrl) + '" target="_blank" rel="noopener" title="' + esc(s.tailnetUrl) + '">' + esc(label) + '</a>'
    : '<span class="path dead" title="' + esc(full) + '">' + esc(label || '—') + '</span>';
  // HTTP 状态只在**不正常**时才显示。健康的 200 是废话，而且会把行高挤乱。
  const warn = (st === 'warn' && s.http && s.http.status)
    ? '<span class="tag bad">HTTP ' + esc(s.http.status) + '</span>' : '';
  const acts = busy
    ? '<span class="spin" role="img" aria-label="处理中"></span>'
    : '<button data-act="start" data-id="' + esc(s.id) + '"' + (s.running ? ' disabled' : '') + '>启动</button>' +
      '<button data-act="restart" data-id="' + esc(s.id) + '">重启</button>' +
      '<button data-act="stop" data-id="' + esc(s.id) + '"' + (s.running ? '' : ' disabled') + '>停止</button>';
  return '<li class="row" data-state="' + st + '"' + (booted ? '' : ' style="animation-delay:' + Math.min(idx * 45, 360) + 'ms"') + '>' +
    '<span class="lamp" data-state="' + st + '" role="img" aria-label="' + STATE_TEXT[st] + '" title="' + STATE_TEXT[st] + '"></span>' +
    '<span class="who"><b title="' + esc(s.name) + '">' + esc(s.name) + '</b>' +
      (s.autostart ? '<span class="tag">自启</span>' : '') + warn + '</span>' +
    '<span class="num port"' + (s.port ? '' : ' data-empty') + ' aria-label="端口 ' + esc(s.port || '无') + '">' + esc(s.port || '—') + '</span>' +
    '<span class="num pid"' + (s.pid ? '' : ' data-empty') + ' aria-label="进程号 ' + esc(s.pid || '无') + '">' + esc(s.pid || '—') + '</span>' +
    href +
    '<span class="acts">' + acts + '</span></li>';
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
  // 舰队灯带：和列表同源，只是压缩成一行
  $('strip').innerHTML = services.map((s) =>
    '<i data-state="' + lampState(s) + '"></i>').join('');
  const on = services.filter((s) => s.running).length;
  $('count').textContent = on + '/' + services.length;
  $('count').setAttribute('aria-label', services.length + ' 个服务，' + on + ' 个在线');
  // 首屏点亮动画只放一次，之后每 5 秒的刷新不再重放
  if (!booted && services.length) {
    document.querySelector('.panel').classList.add('boot');
    booted = true;
    setTimeout(() => document.querySelector('.panel').classList.remove('boot'), 1200);
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
  // 主机名从第一条 tailnetUrl 里取，取不到就不显示
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
    // 失败要说清楚「哪个 + 为什么」，只报「失败」等于没说
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
