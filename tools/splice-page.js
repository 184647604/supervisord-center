// 页面源码的「拆 / 装」工具。
//
// 为什么需要：页面是嵌在 supervisord-center.js 里的模板字面量（单文件部署是
// 这个项目的设计约束，不能改成外部 .html）。但直接在 JS 字符串里改上万字符
// 的 HTML 很难受 —— 编辑器补全、缩进、语法高亮全都不认。所以：
//
//   拆: node tools/splice-page.js extract        -> PAGE_HTML -> src/_newpage.html
//       node tools/splice-page.js extract login  -> LOGIN_HTML -> src/_login.html
//   改: 用普通 HTML 工具编辑拆出来的文件
//   装: node tools/splice-page.js [login]        -> 拼回 supervisord-center.js
//   验: node tools/verify-page.js                -> 确认装进去了、行为特征没丢
//
// 两个字面量都支持。之前只支持 PAGE_HTML，改登录页就只能手工编辑 JS 字符串里
// 的 HTML —— 而那正是这个工具存在的理由。
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const srcFile = path.join(root, 'src', 'supervisord-center.js');
const BT = String.fromCharCode(96); // 反引号

// 每个目标：字面量名、拆出来的中转文件名。
// 中转文件都不入库（.gitignore 已排除），因为主程序里的字面量才是唯一真相。
const TARGETS = {
  page: { name: 'PAGE_HTML', file: '_newpage.html', label: 'PAGE_HTML' },
  login: { name: 'LOGIN_HTML', file: '_login.html', label: 'LOGIN_HTML' },
};

const key = process.argv[2] === 'login' || process.argv[3] === 'login' ? 'login' : 'page';
const T = TARGETS[key];
const tmpFile = path.join(root, 'src', T.file);

const src = fs.readFileSync(srcFile, 'utf8');
const startMark = 'const ' + T.name + ' = ' + BT;
const s = src.indexOf(startMark);
if (s < 0) { console.error('找不到 ' + T.name + ' 起点'); process.exit(1); }
const e = src.indexOf(BT + ';', s + startMark.length);
if (e < 0) { console.error('找不到 ' + T.name + ' 终点'); process.exit(1); }

// ── 拆 ──────────────────────────────────────────────────────────────────
if (process.argv.includes('extract')) {
  const body = src.slice(s + startMark.length, e);
  fs.writeFileSync(tmpFile, body + '\n');
  console.log('  已导出 ' + T.label + ' -> src/' + T.file);
  console.log('  ' + body.length + ' 字符');
  process.exit(0);
}

// ── 装 ──────────────────────────────────────────────────────────────────
if (!fs.existsSync(tmpFile)) {
  console.error('找不到 ' + tmpFile);
  console.error('先跑 node tools/splice-page.js extract ' + (key === 'login' ? 'login' : '') + ' 把当前内容导出来。');
  process.exit(1);
}
const html = fs.readFileSync(tmpFile, 'utf8');

// 要塞进 JS 模板字面量，这三种字符会直接破坏它或造成插值
const fatal = [
  ['`', (html.match(/`/g) || []).length, '反引号会提前结束模板字面量'],
  ['${', (html.match(/\$\{/g) || []).length, '${ 会被当成插值'],
  ['\\', (html.match(/\\/g) || []).length, '反斜杠会被当转义'],
];
let bad = false;
for (const [label, n, why] of fatal) {
  const ok = n === 0;
  if (!ok) bad = true;
  console.log('  ' + (ok ? '[ok]  ' : '[FAIL]') + ' ' + label + ' 出现 ' + n + ' 次' + (ok ? '' : '  —— ' + why));
}
if (!html.trimEnd().endsWith('</html>')) { bad = true; console.log('  [FAIL] 结尾不是 </html>'); }
if (bad) { console.error('\n内容含不能拼接的字符，已中止（源文件未改动）。'); process.exit(1); }

const out = src.slice(0, s) + startMark + html.replace(/\n$/, '') + BT + ';' + src.slice(e + 2);
fs.writeFileSync(srcFile, out);
console.log('\n  ' + T.label + ' 拼接完成：' + (e - s - startMark.length) + ' 字符 -> ' + html.trimEnd().length + ' 字符');
console.log('  文件总长：' + src.length + ' -> ' + out.length);
