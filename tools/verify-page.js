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

const checks = [
  ['PAGE_HTML 长度 > 5000', body.length > 5000, body.length + ' 字符'],
  ['以 </html> 结尾', body.trimEnd().endsWith('</html>'), ''],
  ['含指示灯 .lamp', body.includes('class="lamp"'), ''],
  ['含舰队灯带 strip', body.includes('id="strip"'), ''],
  ['含响应式断点 640px', body.includes('max-width:640px'), ''],
  ['含 safe-area-inset', body.includes('env(safe-area-inset-bottom)'), ''],
  ['含 prefers-reduced-motion', body.includes('prefers-reduced-motion'), ''],
  ['含 grid-template-areas', body.includes('grid-template-areas'), ''],
  ['含 aria-live', body.includes('aria-live'), ''],
  ['无旧 <table>', !body.includes('<table'), ''],
  ['无旧 .dot 圆点', !body.includes('class="dot'), ''],
  ['无旧 .sub 副标题', !body.includes('class="sub"'), ''],
  ['无 autofocus', !body.includes('autofocus'), ''],
  ['无 user-scalable=no', !body.includes('user-scalable'), ''],
  ['无 transition:all', !body.includes('transition:all'), ''],
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
