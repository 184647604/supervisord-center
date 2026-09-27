// 入库前哨兵：扫出**不该进版本库**的东西。
//
// 为什么需要：这个仓库是要公开推到 GitHub 的。而这些工具的用途恰恰是
// 「拿真实令牌去测真实服务」，很容易顺手把生产令牌写进测试文件 ——
// 已经发生过一次：tools/ 里两个夹具硬编码了生产令牌，而那个令牌
// 同时还是 workbuddy / doubao 的 ADMIN_KEY。
//
// 一旦推上去，即使事后删除，**历史里还在**，只能靠 force-push 或
// 改写历史才能清掉。所以必须在 push 之前拦。
//
// 用法: node tools/scan-secrets.js
//       node tools/scan-secrets.js --staged   只扫暂存区
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const stagedOnly = process.argv.includes('--staged');

// 真实凭据的来源：运行时配置（不入库，但在本机存在）。
// 脚本读它来比对 —— 这样即使令牌换了，哨兵也不用改。
const runtimeCfg = path.join(process.env.USERPROFILE || process.env.HOME || '', '.supervisord-center', 'supervisord-center.config.json');

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// 收集要检查的文件列表
function listFiles() {
  if (stagedOnly) {
    return git(['diff', '--cached', '--name-only', '--diff-filter=ACMR'])
      .split('\n').map((s) => s.trim()).filter(Boolean);
  }
  // 全部被跟踪的文件
  return git(['ls-files']).split('\n').map((s) => s.trim()).filter(Boolean);
}

// 要搜的「危险串」：真实令牌 + 常见凭据格式
const needles = [];
try {
  const cfg = JSON.parse(fs.readFileSync(runtimeCfg, 'utf8').replace(/^\uFEFF/, ''));
  if (cfg.token && String(cfg.token).length >= 6) {
    needles.push({ s: String(cfg.token), why: '运行时配置里的真实控制面令牌' });
  }
} catch { /* 配置不在就算了，下面还有通用格式兜底 */ }

// 通用模式（正则）
const patterns = [
  { re: /ghp_[A-Za-z0-9]{20,}/g, why: 'GitHub personal access token' },
  { re: /github_pat_[A-Za-z0-9_]{20,}/g, why: 'GitHub fine-grained PAT' },
  { re: /sk-[A-Za-z0-9]{20,}/g, why: 'API key（OpenAI 风格）' },
  { re: /AKIA[0-9A-Z]{16}/g, why: 'AWS access key id' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, why: '私钥' },
  { re: /xox[baprs]-[A-Za-z0-9-]{10,}/g, why: 'Slack token' },
];

// 明确允许的例外：这些是**占位符**，不是真凭据
const allow = [
  /__TOKEN__/,                    // 配置模板占位符
  /test-token-not-a-real-credential/,
  /ui-harness-local-only/,
  /sk-f1ac78e3834242b985f6c3df4f265ee9/, // 本机 dsh 凭据文件里的占位串（若出现）
];

const files = listFiles();
let hits = 0;

for (const rel of files) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) continue;
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
  if (text.includes('\u0000')) continue; // 二进制
  const lines = text.split('\n');

  for (const { s, why } of needles) {
    lines.forEach((line, i) => {
      if (!line.includes(s)) return;
      if (allow.some((a) => a.test(line))) return;
      hits++;
      console.log('  [LEAK] ' + rel + ':' + (i + 1) + '  ' + why);
      console.log('         ' + line.trim().slice(0, 100));
    });
  }

  for (const { re, why } of patterns) {
    lines.forEach((line, i) => {
      const m = line.match(re);
      if (!m) return;
      if (allow.some((a) => a.test(line))) return;
      hits++;
      console.log('  [LEAK] ' + rel + ':' + (i + 1) + '  ' + why + '  ' + m[0].slice(0, 20) + '…');
    });
  }
}

console.log('');
console.log('  扫描范围: ' + (stagedOnly ? '暂存区' : '全部被跟踪文件') + '（' + files.length + ' 个）');
if (needles.length) console.log('  比对来源: 运行时配置的真实令牌');
else console.log('  比对来源: 仅通用格式（运行时配置没读到）');

if (hits) {
  console.log('\n  发现 ' + hits + ' 处疑似真实凭据 —— 不要 push。');
  console.log('  修完后如果已经 commit 过，注意历史里还在，需要改写历史或换掉那个凭据。');
  process.exit(1);
}
console.log('\n  未发现真实凭据。');
