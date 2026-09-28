// 拼接后自检：确认 PAGE_HTML 是新页面、且没有残留旧标记。
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const f = path.join(__dirname, '..', 'src', 'supervisord-center.js');
const t = fs.readFileSync(f, 'utf8');

const startMark = 'const PAGE_HTML = ' + String.fromCharCode(96);
const s = t.indexOf(startMark);
if (s < 0) { console.error('找不到 PAGE_HTML'); process.exit(1); }
const e = t.indexOf(String.fromCharCode(96) + ';', s + startMark.length);
const body = t.slice(s + startMark.length, e);

// 这些断言查的是**行为特征**，不是具体的 class 名。
//
// 早先这里写死了 .lamp / id="strip" 并禁止 .dot / .sub，结果改版时全部误报 ——
// 页面明明好好的，自检却在喊失败。断言绑到实现的细节上，就会变成「改样式必须
// 顺手改测试」，久而久之没人再认真看它报什么。所以现在只查真正不能丢的东西：
// 三个状态、状态可视化、响应式、可访问性。
const checks = [
  ['PAGE_HTML 长度 > 5000', body.length > 5000, body.length + ' 字符'],
  ['以 </html> 结尾', body.trimEnd().endsWith('</html>'), ''],

  // 状态可视化：必须有三种状态，且状态是数据驱动的
  ['含 on/off/warn 三态', /['"]on['"]/.test(body) && /['"]off['"]/.test(body) && /['"]warn['"]/.test(body), ''],
  ['状态点带 aria-label', body.includes('role="img"') && body.includes('aria-label'), ''],
  ['状态不只靠颜色（有文字状态）', body.includes('STATE_TEXT'), ''],

  // 响应式与可访问性
  ['含响应式断点', body.includes('@media (max-width'), ''],
  ['含 safe-area-inset', body.includes('env(safe-area-inset'), ''],
  ['含 prefers-reduced-motion', body.includes('prefers-reduced-motion'), ''],
  ['含 grid-template-areas', body.includes('grid-template-areas'), ''],
  ['含 aria-live', body.includes('aria-live'), ''],

  // 配色克制：颜色必须集中在 :root 变量里，不许散落硬编码
  ['配色走 CSS 变量', body.includes(':root{') && body.includes('var(--'), ''],
  ['无硬编码蓝色链接', !body.includes('#6cb6ff'), ''],

  // 历史遗留：这些是真不该再出现的
  ['无 <table>', !body.includes('<table'), ''],
  ['无 autofocus', !body.includes('autofocus'), ''],
  ['无 user-scalable=no', !body.includes('user-scalable'), ''],
  ['无 transition:all', !body.includes('transition:all'), ''],
  ['无外部资源引用', !/src=["']http/.test(body) && !/href=["']http/.test(body), ''],
];

let bad = 0;
for (const [name, ok, extra] of checks) {
  if (!ok) bad++;
  console.log('  ' + (ok ? '[ok]  ' : '[FAIL]') + ' ' + name + (extra ? '  (' + extra + ')' : ''));
}

// 登录页也一并检查（它是另一个字面量）
const ls = t.indexOf('const LOGIN_HTML = ' + String.fromCharCode(96));
const le = t.indexOf(String.fromCharCode(96) + ';', ls + 20);
const login = t.slice(ls + 20, le);
const lchecks = [
  ['LOGIN_HTML 含品牌标记 .mark', login.includes('class="mark"'), ''],
  ['LOGIN_HTML 有 label for=t', login.includes('for="t"'), ''],
  ['LOGIN_HTML 无 autofocus', !login.includes('autofocus'), ''],
  ['LOGIN_HTML 含 role=alert', login.includes('role="alert"'), ''],
];
for (const [name, ok] of lchecks) {
  if (!ok) bad++;
  console.log('  ' + (ok ? '[ok]  ' : '[FAIL]') + ' ' + name);
}

console.log('\n' + (bad === 0 ? '全部通过。' : bad + ' 项失败。'));
process.exit(bad === 0 ? 0 : 1);
