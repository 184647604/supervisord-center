// 截图工具 —— 绕开卡住的 Playwright MCP 服务。
//
// 为什么需要它：MCP 那个 playwright 服务有时会卡死（browser_navigate 一直
// 超时），而本机其实已经装好了 playwright 本体和 chromium。直接 require 它
// 起一个独立浏览器，就完全不依赖那个服务了。
//
// 用法：
//   node tools/shot.js <url> <输出文件> [宽] [高] [--full] [--token=xxx]
// 例：
//   node tools/shot.js http://127.0.0.1:3091/ _shots/desktop.png 1200 900 --token=ui-harness-local-only
const path = require('node:path');
const fs = require('node:fs');

// playwright 装在 @playwright/mcp 的依赖里，不在全局 node_modules
const PW = path.join(
  process.env.APPDATA || '',
  'npm', 'node_modules', '@playwright', 'mcp', 'node_modules', 'playwright'
);
const { chromium } = require(PW);

const [url, out, w = '1200', h = '900'] = process.argv.slice(2);
const fullPage = process.argv.includes('--full');
const tokenArg = process.argv.find((a) => a.startsWith('--token='));
const token = tokenArg ? tokenArg.slice('--token='.length) : null;

if (!url || !out) {
  console.error('用法: node tools/shot.js <url> <out.png> [宽] [高] [--full] [--token=...]');
  process.exit(2);
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({
    viewport: { width: Number(w), height: Number(h) },
    deviceScaleFactor: 2,          // 2x：细节（1px 边框、灯的高光）看得清
    locale: 'zh-CN',
  });
  const page = await ctx.newPage();

  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  // 先登录拿 Cookie（管理页需要），登录走 POST body
  if (token) {
    await page.goto(new URL('/', url).href, { waitUntil: 'domcontentloaded' });
    await page.evaluate(async (tk) => {
      await fetch(location.pathname, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'token=' + encodeURIComponent(tk),
        credentials: 'same-origin',
      });
    }, token);
  }

  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);          // 等首屏点亮动画走完

  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  await page.screenshot({ path: out, fullPage });

  console.log('  截图: ' + out + '  (' + w + 'x' + h + (fullPage ? ', full' : '') + ')');

  // 横向溢出检查：移动端最容易出的问题
  const m = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
    rows: document.querySelectorAll('.row').length,
    lamps: document.querySelectorAll('.lamp').length,
    count: (document.getElementById('count') || {}).textContent || '',
  }));
  console.log('  行数=' + m.rows + ' 灯=' + m.lamps + ' 计数=' + m.count);
  console.log('  宽度: scrollW=' + m.scrollW + ' clientW=' + m.clientW +
    (m.scrollW > m.clientW ? '  [!!] 横向溢出' : '  [ok] 无溢出'));
  if (errors.length) {
    console.log('  控制台错误:');
    errors.slice(0, 6).forEach((e) => console.log('    ' + e));
  } else {
    console.log('  控制台: 无错误');
  }

  await browser.close();
})().catch((e) => { console.error('失败: ' + e.message); process.exit(1); });
