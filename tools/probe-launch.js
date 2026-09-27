'use strict';
/*
 * 启动方式探针 —— 决定 supervisord-center 该用什么姿势拉起 .cmd 包装器。
 *
 * 背景：现有服务的 .cmd 里都有 `:loop` 自愈循环，循环末尾是
 *   timeout /t 5 /nobreak >nul
 * 而 `timeout` 需要一个**真正的控制台**做 stdin。没有控制台时它立刻失败
 * （中文报错「输入重定向不受支持」），循环退化成**紧循环** ——
 * 实测 12 秒跑了 94 次，约每秒 8 次重启风暴。
 *
 * 这不只是理论问题：supervisord-center 自己是被 WMI 创建的（没有控制台），
 * 它 spawn 出来的子进程自然也拿不到控制台。所以必须先量清楚：
 * 哪种 spawn 配置能让 `timeout` 正常工作？
 *
 * 用法：node tools/probe-launch.js
 */

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const NODE = process.execPath;
const ROOT = path.join(os.tmpdir(), 'sdc-probe-' + process.pid);

// 一个「健康服务」：起来后一直监听，模拟正常情况
const HEALTHY = 'healthy.js';
// 一个「崩溃服务」：立刻退出，逼出 :loop 自愈路径，用来量循环节流
const CRASH = 'crash.js';

function writeFixtures(dir, port) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, HEALTHY),
    `require('node:http').createServer((q,s)=>s.end('ok')).listen(${port},'127.0.0.1');\n`);
  fs.writeFileSync(path.join(dir, CRASH), 'process.exit(1);\n');
  // 忠实复制现有 .cmd 的结构：:loop + timeout 5
  const wrapper = (entry) => [
    '@echo off',
    'cd /d "%~dp0"',
    ':loop',
    `"${NODE}" ${entry}`,
    'echo tick >> count.txt',
    'timeout /t 5 /nobreak >nul',
    'goto loop',
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(dir, 'healthy.cmd'), wrapper(HEALTHY));
  fs.writeFileSync(path.join(dir, 'crash.cmd'), wrapper(CRASH), 'ascii');
  fs.writeFileSync(path.join(dir, 'healthy.cmd'), wrapper(HEALTHY), 'ascii');
}

function probe(port, timeoutMs = 700) {
  return new Promise((resolve) => {
    const s = require('node:net').connect({ host: '127.0.0.1', port });
    let done = false;
    const fin = (v) => { if (!done) { done = true; s.destroy(); resolve(v); } };
    s.setTimeout(timeoutMs);
    s.once('connect', () => fin(true));
    s.once('error', () => fin(false));
    s.once('timeout', () => fin(false));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 用 taskkill /T 杀整棵树 —— 只杀 cmd 本身的话，它 :loop 里的子进程会活下来
function killTree(pid) {
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); }
  catch { /* 已经退了 */ }
}

const VARIANTS = {
  'A  detached + hide': { detached: true, windowsHide: true, stdio: 'ignore' },
  'B  detached + show': { detached: true, windowsHide: false, stdio: 'ignore' },
  'C  plain (no detach)': { detached: false, windowsHide: true, stdio: 'ignore' },
  'D  shell:true': { detached: true, windowsHide: true, stdio: 'ignore', shell: true },
};

async function testStart(label, opts, dir, port) {
  const wrapper = path.join(dir, 'healthy.cmd');
  let child;
  try {
    child = opts.shell
      ? spawn(wrapper, [], { ...opts, cwd: dir })
      : spawn('cmd.exe', ['/c', wrapper], { ...opts, cwd: dir });
  } catch (e) {
    return { label, started: false, note: 'spawn 抛异常: ' + e.message };
  }
  let spawnErr = null;
  child.once('error', (e) => { spawnErr = e.message; });

  let up = false;
  for (let i = 0; i < 16; i++) { if (await probe(port)) { up = true; break; } await sleep(500); }
  killTree(child.pid);
  await sleep(400);
  return { label, started: up, pid: child.pid, note: spawnErr ? 'error事件: ' + spawnErr : '' };
}

async function testLoop(label, opts, dir) {
  const wrapper = path.join(dir, 'crash.cmd');
  const countFile = path.join(dir, 'count.txt');
  fs.rmSync(countFile, { force: true });
  let child;
  try {
    child = opts.shell
      ? spawn(wrapper, [], { ...opts, cwd: dir })
      : spawn('cmd.exe', ['/c', wrapper], { ...opts, cwd: dir });
  } catch (e) {
    return { label, ticks: -1, note: 'spawn 抛异常' };
  }
  await sleep(7000);
  killTree(child.pid);
  await sleep(400);
  let ticks = 0;
  try { ticks = fs.readFileSync(countFile, 'utf8').split('\n').filter(Boolean).length; } catch { }
  return { label, ticks, verdict: ticks <= 3 ? 'throttled OK' : 'TIGHT LOOP' };
}

(async () => {
  console.log('启动方式探针 —— 每个变体独立目录，跑完 taskkill /T 清树\n');
  fs.rmSync(ROOT, { recursive: true, force: true });

  console.log('--- 测试 1：服务能否被拉起（健康服务，应开始监听）---');
  let port = 8300;
  for (const [label, opts] of Object.entries(VARIANTS)) {
    const dir = path.join(ROOT, 'start-' + label.slice(0, 1));
    writeFixtures(dir, port);
    const r = await testStart(label, opts, dir, port);
    console.log(`  ${label.padEnd(22)} 监听=${r.started ? '是' : '否'}  (pid ${r.pid ?? '-'}) ${r.note}`);
    port++;
  }

  console.log('\n--- 测试 2：崩溃时 :loop 是否被节流（7 秒内应只跑 1~2 次）---');
  for (const [label, opts] of Object.entries(VARIANTS)) {
    const dir = path.join(ROOT, 'loop-' + label.slice(0, 1));
    writeFixtures(dir, 8999);
    const r = await testLoop(label, opts, dir);
    console.log(`  ${label.padEnd(22)} 循环 ${String(r.ticks).padStart(3)} 次  -> ${r.verdict}`);
  }

  // 顺带量一下：把 timeout 换成 ping 是否能不依赖控制台
  console.log('\n--- 测试 3：绕开 timeout（用 ping 当延时）是否可行 ---');
  {
    const dir = path.join(ROOT, 'ping');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, CRASH), 'process.exit(1);\n');
    fs.writeFileSync(path.join(dir, 'w.cmd'), [
      '@echo off', 'cd /d "%~dp0"', ':loop',
      `"${NODE}" ${CRASH}`,
      'echo tick >> count.txt',
      'ping -n 6 127.0.0.1 >nul',
      'goto loop', '',
    ].join('\r\n'), 'ascii');
    const child = spawn('cmd.exe', ['/c', path.join(dir, 'w.cmd')],
      { detached: true, windowsHide: true, stdio: 'ignore', cwd: dir });
    await sleep(7000);
    killTree(child.pid);
    await sleep(400);
    let ticks = 0;
    try { ticks = fs.readFileSync(path.join(dir, 'count.txt'), 'utf8').split('\n').filter(Boolean).length; } catch { }
    console.log(`  ping -n 6 当延时        循环 ${ticks} 次  -> ${ticks <= 3 ? 'throttled OK' : 'TIGHT LOOP'}`);
  }

  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log('\n完成，夹具已清理。');
})();
