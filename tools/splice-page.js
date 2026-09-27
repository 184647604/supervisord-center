// 页面源码的「拆 / 装」工具。
//
// 为什么需要：页面是嵌在 supervisord-center.js 里的模板字面量（单文件部署是
// 这个项目的设计约束，不能改成外部 .html）。但直接在 JS 字符串里改 15000 字符
// 的 HTML 很难受 —— 编辑器补全、缩进、语法高亮全都不认。所以：
//
//   拆: node tools/splice-page.js extract   -> 把 PAGE_HTML 导出成 src/_newpage.html
//   改: 用普通 HTML 工具编辑 src/_newpage.html
//   装: node tools/splice-page.js           -> 拼回 supervisord-center.js
//   验: node tools/verify-page.js           -> 确认装进去了、且没有旧标记残留
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const srcFile = path.join(root, 'src', 'supervisord-center.js');
const htmlFile = path.join(root, 'src', '_newpage.html');
const BT = String.fromCharCode(96); // 反引号

const src = fs.readFileSync(srcFile, 'utf8');
const startMark = 'const PAGE_HTML = ' + BT;
const s = src.indexOf(startMark);
if (s < 0) { console.error('找不到 PAGE_HTML 起点'); process.exit(1); }
const e = src.indexOf(BT + ';', s + startMark.length);
if (e < 0) { console.error('找不到 PAGE_HTML 终点'); process.exit(1); }

// ── 拆 ──────────────────────────────────────────────────────────────────
if (process.argv[2] === 'extract') {
  const body = src.slice(s + startMark.length, e);
  fs.writeFileSync(htmlFile, body + '\n');
  console.log('  已导出 PAGE_HTML -> src/_newpage.html');
  console.log('  ' + body.length + ' 字符');
  process.exit(0);
}

// ── 装 ──────────────────────────────────────────────────────────────────
if (!fs.existsSync(htmlFile)) {
  console.error('找不到 ' + htmlFile);
  console.error('先跑 node tools/splice-page.js extract 把当前页面导出来。');
  process.exit(1);
}
const html = fs.readFileSync(htmlFile, 'utf8');

// 页面要塞进 JS 模板字面量，这三种字符会直接破坏它或造成插值
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
if (bad) { console.error('\n页面含不能拼接的字符，已中止（源文件未改动）。'); process.exit(1); }

const out = src.slice(0, s) + startMark + html.replace(/\n$/, '') + BT + ';' + src.slice(e + 2);
fs.writeFileSync(srcFile, out);
console.log('\n  拼接完成：' + (e - s - startMark.length) + ' 字符 -> ' + html.trimEnd().length + ' 字符');
console.log('  文件总长：' + src.length + ' -> ' + out.length);
