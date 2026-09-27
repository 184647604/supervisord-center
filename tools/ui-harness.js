// UI 试验台：在备用端口起一个新版页面 + 三个假服务，供浏览器逐项检查。
//
// 为什么不直接看生产页：生产控制面管着正在跑的 DSH（也就是宿主进程本身），
// 拿它当渲染试验台，一旦手滑点到按钮就可能把自己的会话弄没。
//
// 用法：
//   node tools/ui-harness.js          启动
//   node tools/ui-harness.js stop     停止
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(os.tmpdir(), 'sdc-ui');
const PORT = 3091;
// 试验台自己的假令牌 —— 这里**绝不能**填真实令牌（会随代码进版本库）。
const TOKEN = process.env.SDC_UI_TOKEN || 'ui-harness-local-only';
const PIDFILE = path.join(ROOT, 'pids.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// taskkill 是异步的：不等它落地就删目录会 EPERM（Windows 上文件还被占着）。
// 这里同步等 taskkill 退出，再重试删除。
function killTree(pid) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    try {
      const p = spawn('taskkill', ['/PID', String(pid), '/T', '/F'],
        { stdio: 'ignore', windowsHide: true });
      p.on('exit', finish);
      p.on('error', finish);
      setTimeout(finish, 4000);
    } catch { finish(); }
  });
}

async function rmDir(dir) {
  for (let i = 0; i < 12; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return true; }
    catch { await sleep(400); }
  }
  return false;
}

if (process.argv[2] === 'stop') {
  (async () => {
    let pids = [];
    try { pids = JSON.parse(fs.readFileSync(PIDFILE, 'utf8')); } catch { }
    // 只认 pidfile 里记下的 pid，**绝不按命令行文本匹配** ——
    // 调这个脚本的 shell 自己的命令行里就含 'sdc-ui' 字样，按文本找会把自己杀掉。
    for (const p of pids) await killTree(p);
    await sleep(500);
    const gone = await rmDir(ROOT);
    console.log((gone ? '已停止 ' : '进程已停，但目录还被占用：') + pids.length + ' 个进程' + (gone ? '并清理 ' + ROOT : ' ' + ROOT));
    process.exit(0);
  })();
} else {
  start();
}

async function start() {
  fs.mkdirSync(ROOT, { recursive: true });
  const gone = await rmDir(ROOT);
  if (!gone) console.warn('警告：旧目录未清干净，可能有实例还在跑');
  fs.mkdirSync(ROOT, { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'src', 'supervisord-center.js'),
    path.join(ROOT, 'supervisord-center.js'));

  // 假服务单独起进程：否则它们会随本脚本退出而消失，页面就只剩三个离线灯
  const fakes = spawn(process.execPath, [path.join(__dirname, 'ui-fakes.js')], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  fakes.unref();

  const cfg = {
    port: PORT,
    host: '127.0.0.1',
    token: TOKEN,
    log: path.join(ROOT, 'ui.log'),
    // 假主机名 —— 试验台不连 tailnet，这里只是让页面有东西可显示
    tailnetBase: 'https://demo-node.example-tailnet.ts.net',
    startWaitMs: 4000,
    services: [
      { id: 'alpha', name: 'Alpha 服务', port: 8097, via: 'node', node: process.execPath,
        bin: '', args: [], cwd: ROOT, path: '/alpha/', autostart: true, healthPath: '/health' },
      { id: 'beta', name: 'Beta 带很长名字的服务', port: 8098, via: 'node', node: process.execPath,
        bin: '', args: [], cwd: ROOT, path: '/beta/', autostart: false, healthPath: '/health' },
      { id: 'gamma', name: 'Gamma', port: 8099, via: 'node', node: process.execPath,
        bin: path.join(__dirname, 'ui-target.js'), args: ['8099'], cwd: ROOT,
        path: '/gamma/', autostart: false, healthPath: '/health' },
    ],
  };
  fs.writeFileSync(path.join(ROOT, 'supervisord-center.config.json'), JSON.stringify(cfg, null, 2));

  const center = spawn(process.execPath, [path.join(ROOT, 'supervisord-center.js')], {
    detached: true, stdio: 'ignore', windowsHide: true, cwd: ROOT,
  });
  center.unref();

  for (let i = 0; i < 40; i++) {
    try { await fetch('http://127.0.0.1:' + PORT + '/health'); break; }
    catch { await new Promise((r) => setTimeout(r, 300)); }
  }
  fs.writeFileSync(PIDFILE, JSON.stringify([center.pid, fakes.pid]));

  console.log('试验台: http://127.0.0.1:' + PORT + '/     token=' + TOKEN);
  console.log('  8097 在线+健康(绿)   8098 在线+HTTP500(琥珀)   8099 离线(灭)');
  console.log('  pid: center=' + center.pid + ' fakes=' + fakes.pid);
  console.log('停止: node tools/ui-harness.js stop');
}
