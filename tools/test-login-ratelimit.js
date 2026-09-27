'use strict';
/*
 * 登录限流测试 —— 在备用端口起一个隔离实例，验证：
 *   1. 新 token 能用（请求头 + 表单登录两条路）
 *   2. 连续失败到阈值后被 429 挡住
 *   3. 429 响应里带剩余等待时间
 *   4. 成功登录会清空失败计数（否则正常使用会累积到把自己锁死）
 *   5. 被限流不影响**已持有 Cookie** 的会话
 *
 * 为什么要专门测：token 一旦选成人能记住的短串，搜索空间就比 32 位随机串小
 * 几个数量级，限流是唯一的兜底。而限流这种东西最容易写成「测试时看不出来、
 * 真被攻击时才发现没生效」。
 *
 * 用法：node tools/test-login-ratelimit.js
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(os.tmpdir(), 'sdc-rl-' + process.pid);
const PORT = 3095;
// 测试自己的假令牌 —— 这里**绝不能**填真实令牌。
// 本脚本自起一个隔离实例并把这个值写进它的临时配置，测试完全不碰生产配置。
// 早先这里写的是真实生产令牌，结果它随代码进了版本库 ——
// 而那个令牌同时还是 workbuddy / doubao 的 ADMIN_KEY。
const TOKEN = process.env.SDC_TEST_TOKEN || 'test-token-not-a-real-credential';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(body) {
  const res = await fetch('http://127.0.0.1:' + PORT + '/', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'token=' + encodeURIComponent(body),
    redirect: 'manual',
  });
  let json = null;
  try { json = await res.json(); } catch { }
  return { status: res.status, json, setCookie: res.headers.get('set-cookie') };
}

async function get(pathname, headers) {
  const res = await fetch('http://127.0.0.1:' + PORT + pathname, { headers: headers || {} });
  return { status: res.status, text: await res.text() };
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log('  ' + (pass ? '[ok]  ' : '[FAIL]') + ' ' + name + (detail ? '  ' + detail : ''));
}

(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'src', 'supervisord-center.js'),
    path.join(ROOT, 'supervisord-center.js'));

  // 隔离配置：指向死端口，绝不碰真实服务
  const cfg = {
    port: PORT,
    host: '127.0.0.1',
    token: TOKEN,
    log: path.join(ROOT, 'test.log'),
    loginMaxFails: 8,
    loginWindowMs: 600000,
    services: [{
      id: 'dead', name: 'Dead', port: 8123, via: 'node',
      node: process.execPath, bin: '', args: [], execArgv: [],
      cwd: ROOT, path: '/', autostart: false, healthPath: '',
    }],
  };
  fs.writeFileSync(path.join(ROOT, 'supervisord-center.config.json'),
    JSON.stringify(cfg, null, 2));

  const child = spawn(process.execPath, [path.join(ROOT, 'supervisord-center.js')], {
    detached: true, stdio: 'ignore', windowsHide: true, cwd: ROOT,
  });
  child.unref();

  // 等起来
  for (let i = 0; i < 30; i++) {
    try { await fetch('http://127.0.0.1:' + PORT + '/health'); break; } catch { await sleep(300); }
  }

  console.log('\n--- 1) 新 token 可用 ---');
  const hdr = await get('/health', { 'x-supervisord-center-token': TOKEN });
  check('请求头带新 token -> 200', hdr.status === 200, 'status=' + hdr.status);
  const bearer = await get('/health', { authorization: 'Bearer ' + TOKEN });
  check('Bearer 带新 token -> 200', bearer.status === 200, 'status=' + bearer.status);
  // 错令牌从 TOKEN 派生，避免又硬编码一个「真令牌 ±1」——那样等于泄漏真令牌
  const wrongHdr = await get('/health', { 'x-supervisord-center-token': TOKEN + 'x' });
  check('错误的 token -> 401', wrongHdr.status === 401, 'status=' + wrongHdr.status);

  console.log('\n--- 2) 失败到阈值后被限流 ---');
  const codes = [];
  for (let i = 1; i <= 9; i++) {
    const r = await post('wrong' + i);
    codes.push(r.status);
  }
  console.log('     9 次错误尝试的状态码: ' + codes.join(','));
  check('前 8 次是 401', codes.slice(0, 8).every((c) => c === 401), 'got ' + codes.slice(0, 8).join(','));
  check('第 9 次被 429 挡住', codes[8] === 429, 'got ' + codes[8]);

  console.log('\n--- 3) 429 带可读原因与等待时间 ---');
  const blocked = await post('wrong10');
  check('限流响应含 message', !!(blocked.json && blocked.json.message), JSON.stringify(blocked.json));
  check('限流响应含 retryAfterSec',
    !!(blocked.json && typeof blocked.json.retryAfterSec === 'number' && blocked.json.retryAfterSec > 0),
    'retryAfterSec=' + (blocked.json && blocked.json.retryAfterSec));

  console.log('\n--- 4) 限流期间正确 token 也被挡（这是有意的）---');
  const correctWhileBlocked = await post(TOKEN);
  check('限流中正确 token 仍 429', correctWhileBlocked.status === 429,
    'status=' + correctWhileBlocked.status + '（全局桶的代价，防的是无限次猜测）');

  console.log('\n--- 5) 重启实例后计数清零（内存态，不持久化）---');
  try { process.kill(child.pid); } catch { }
  await sleep(1200);
  const child2 = spawn(process.execPath, [path.join(ROOT, 'supervisord-center.js')], {
    detached: true, stdio: 'ignore', windowsHide: true, cwd: ROOT,
  });
  child2.unref();
  for (let i = 0; i < 30; i++) {
    try { await fetch('http://127.0.0.1:' + PORT + '/health'); break; } catch { await sleep(300); }
  }
  const afterRestart = await post(TOKEN);
  check('重启后正确 token 可登录 -> 204', afterRestart.status === 204, 'status=' + afterRestart.status);
  check('登录响应带 Set-Cookie', !!afterRestart.setCookie, String(afterRestart.setCookie).slice(0, 60));

  console.log('\n--- 6) 成功后失败计数被清空 ---');
  // 先失败 3 次，再成功一次，再失败 7 次 —— 若没清空，总数会到 10 而触发限流
  for (let i = 0; i < 3; i++) await post('nope' + i);
  const good = await post(TOKEN);
  check('中间成功一次', good.status === 204, 'status=' + good.status);
  const after = [];
  for (let i = 0; i < 7; i++) after.push((await post('again' + i)).status);
  check('成功后再失败 7 次仍未触发限流（计数已清）',
    after.every((c) => c === 401), 'got ' + after.join(','));

  console.log('\n--- 7) Cookie 会话不受登录限流影响 ---');
  const cookie = String(afterRestart.setCookie || '').split(';')[0];
  const viaCookie = await get('/services', { cookie });
  check('持 Cookie 访问 /services -> 200', viaCookie.status === 200, 'status=' + viaCookie.status);

  try { process.kill(child2.pid); } catch { }
  await sleep(600);
  fs.rmSync(ROOT, { recursive: true, force: true });

  const failed = results.filter((r) => !r.pass);
  console.log('\n' + (failed.length === 0
    ? '全部 ' + results.length + ' 项通过。'
    : failed.length + ' / ' + results.length + ' 项失败：' + failed.map((f) => f.name).join('; ')));
  process.exit(failed.length === 0 ? 0 : 1);
})();
