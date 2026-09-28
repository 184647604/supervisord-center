// 界面全面自检：多视口溢出、点击链路、状态渲染、可访问性。
//
// 为什么要有它：界面改版「看着挺好」但可能在某档宽度溢出、某个按钮点不动、
// 或者读屏信息丢了。截图只能证明「我看的那一眼没问题」，证明不了这些。
//
// 用法: node tools/ui-check.js [端口]
//
// ⚠ 破坏性测试只打在试验台上。
// 这个脚本会点击「启动 / 停止」，而停止是真的杀进程。曾经它无条件这么做，
// 我把它指向生产 3099 跑了一遍 —— 第一行在线服务正好是 dsh 本身，于是它
// 把宿主进程杀了（日志：killed tree pid=13512 (dsh port 3080)），控制台随之
// 断线。自检工具不该有这种能力，所以现在按 token 判定：只有试验台的 token
// 才允许点击，其余一律只读。
const path = require('node:path');
const PW = path.join(process.env.APPDATA || '',
  'npm', 'node_modules', '@playwright', 'mcp', 'node_modules', 'playwright');
const { chromium } = require(PW);

const PORT = process.argv[2] || '3091';
const TOKEN = process.env.SDC_UI_TOKEN || 'ui-harness-local-only';
const BASE = 'http://127.0.0.1:' + PORT + '/';

// 试验台的 token 只存在于试验台；别的 token 意味着这是真实实例。
const HARNESS_TOKEN = 'ui-harness-local-only';
const READONLY = process.env.SDC_UI_ALLOW_MUTATE !== '1' && TOKEN !== HARNESS_TOKEN;

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) pass++; else fail++;
  console.log('  ' + (ok ? '[ok]  ' : '[FAIL]') + ' ' + name + (extra !== undefined ? '  (' + extra + ')' : ''));
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ locale: 'zh-CN' });
  const page = await ctx.newPage();

  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  // 登录：拿 Cookie。这里要检查结果 —— 之前没检查，token 错了会一路跑到
  // 最后才以一堆莫名其妙的 FAIL 收场，把「登录失败」伪装成「界面坏了」。
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  const loginStatus = await page.evaluate(async (tk) => {
    const r = await fetch(location.pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'token=' + encodeURIComponent(tk),
      credentials: 'same-origin',
    });
    return r.status;
  }, TOKEN);
  if (loginStatus !== 204 && loginStatus !== 200) {
    console.error('\n  登录失败: HTTP ' + loginStatus + '（端口 ' + PORT + '）');
    console.error('  本脚本用 SDC_UI_TOKEN 登录，默认值是试验台的假 token。');
    console.error('  生产实例: $env:SDC_UI_TOKEN="<真实token>"; node tools/ui-check.js 3099');
    await browser.close();
    process.exit(1);
  }
  console.log('  登录成功 (HTTP ' + loginStatus + ')');

  console.log('\n== 多视口横向溢出 ==');
  for (const [w, h] of [[320, 640], [360, 740], [390, 844], [414, 896], [641, 900], [768, 900], [1024, 800], [1440, 900], [1920, 1080]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(220);
    const m = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth,
      cw: document.documentElement.clientWidth,
    }));
    check(w + 'px 无横向溢出', m.sw <= m.cw, 'scrollW=' + m.sw + ' clientW=' + m.cw);
  }

  console.log('\n== 状态渲染 ==');
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);

  // 行数应当等于接口返回的服务数 —— 这样断言对任何实例都成立，
  // 而不是写死「必须是 3 行」（那只是试验台的数字）。
  const expectedCount = await page.evaluate(async () => {
    const r = await fetch('services', { credentials: 'same-origin' });
    const j = await r.json();
    return (j.services || []).length;
  });

  const states = await page.$$eval('.row', (rows) => rows.map((r) => ({
    state: r.getAttribute('data-state'),
    dot: r.querySelector('.dot') ? r.querySelector('.dot').getAttribute('data-state') : null,
    dotLabel: r.querySelector('.dot') ? r.querySelector('.dot').getAttribute('aria-label') : null,
    text: (r.querySelector('.state') || {}).textContent || '',
    name: (r.querySelector('.name') || {}).textContent || '',
  })));
  // 断言要跟着实例的实际情况走，不能写死「必须有三种状态」。
  // 生产上四个服务全在线是完全正常的；那时还去断言「离线点没有彩色填充」
  // 就会因为「没有离线点」而报 FAIL —— 把「一切正常」报成失败，
  // 是自检脚本最容易失去信任的方式。
  const present = ['on', 'off', 'warn'].filter((s) => states.some((x) => x.state === s));
  check('渲染出至少 1 行', states.length >= 1, states.length);
  check('渲染的行数与接口一致', states.length === expectedCount,
    states.length + ' vs ' + expectedCount);
  console.log('  [info] 本实例出现的状态: ' + present.join(', '));
  check('状态点与行状态一致', states.every((x) => x.state === x.dot));
  check('状态点有可读标签', states.every((x) => x.dotLabel && x.dotLabel.length > 0));
  check('状态有文字（不只靠颜色）', states.every((x) => x.text.trim().length > 0),
    states.map((x) => x.text).join('/'));

  const dotColor = await page.evaluate(() => {
    const out = {};
    document.querySelectorAll('.dot').forEach((d) => {
      out[d.getAttribute('data-state')] = getComputedStyle(d).backgroundColor;
    });
    return out;
  });
  // 只在该状态真的出现时才检查它的颜色
  if (dotColor.off !== undefined) {
    check('离线点无彩色填充', /rgba\(0, 0, 0, 0\)|transparent/.test(dotColor.off), dotColor.off);
  } else {
    console.log('  [skip] 离线点颜色（本实例没有离线服务）');
  }
  if (dotColor.on !== undefined && dotColor.warn !== undefined) {
    check('在线与异常颜色不同', dotColor.on !== dotColor.warn, dotColor.on + ' vs ' + dotColor.warn);
  } else {
    console.log('  [skip] 在线/异常配色对比（本实例缺其一）');
  }

  console.log('\n== 点击链路 ==');
  if (READONLY) {
    // 只读模式下不点任何按钮 —— 见文件头的说明。
    console.log('  [skip] 只读模式，不执行启停（避免杀掉真实服务）');
    console.log('         这是真实实例。要测点击请用试验台: node tools/ui-harness.js');
    console.log('         确需在别处测试: $env:SDC_UI_ALLOW_MUTATE="1"');
  } else {
    // 点击前先摸清每一行的端口，并坚决放过正在为我们提供页面的那一行。
    // 「按位置点第一行」这种写法就是上次杀死 dsh 的原因：生产里第一行
    // 恰好是控制台自己在管的 dsh，一点就断了自己的线。
    const rows = await page.evaluate(() => {
      const panelPort = String(location.port || '');
      return [...document.querySelectorAll('.row')].map((r) => {
        const portEl = r.querySelector('.kv .v');
        return {
          state: r.getAttribute('data-state'),
          name: (r.querySelector('.name') || {}).textContent || '',
          port: portEl ? portEl.textContent.trim() : '',
          self: panelPort !== '' && portEl && portEl.textContent.trim() === panelPort,
        };
      });
    });
    const selfRows = rows.filter((r) => r.self);
    if (selfRows.length) {
      console.log('  [note] 跳过面板自身所在的服务: ' + selfRows.map((r) => r.name + ':' + r.port).join(', '));
    }
    const target = rows.find((r) => r.state === 'off' && !r.self);
    check('存在可安全测试的离线服务', !!target, target ? target.name + ':' + target.port : '无');
    if (target) {
      // 用名字精确定位，不用 :nth-child —— 顺序会随状态变化而变
      const startBtn = await page.evaluateHandle((nm) => {
        const r = [...document.querySelectorAll('.row')]
          .find((x) => ((x.querySelector('.name') || {}).textContent || '') === nm);
        return r ? r.querySelector('button[data-act="start"]') : null;
      }, target.name);
      const el = startBtn.asElement();
      if (el) {
        await el.click();
        await page.waitForTimeout(2500);
        await page.goto(BASE, { waitUntil: 'networkidle' });
        await page.waitForTimeout(300);
        const after = await page.evaluate((nm) => {
          const r = [...document.querySelectorAll('.row')]
            .find((x) => ((x.querySelector('.name') || {}).textContent || '') === nm);
          return r ? r.getAttribute('data-state') : null;
        }, target.name);
        check('点击启动后状态变为在线', after === 'on', String(after));
      }

      // 停回原状。同样按名字定位，并且只停刚启动的那个。
      const stopBtn = await page.evaluateHandle((nm) => {
        const r = [...document.querySelectorAll('.row')]
          .find((x) => ((x.querySelector('.name') || {}).textContent || '') === nm);
        return r ? r.querySelector('button[data-act="stop"]') : null;
      }, target.name);
      const el2 = stopBtn.asElement();
      if (el2) {
        await el2.click();
        await page.waitForTimeout(2500);
        await page.goto(BASE, { waitUntil: 'networkidle' });
        await page.waitForTimeout(300);
        const after2 = await page.evaluate((nm) => {
          const r = [...document.querySelectorAll('.row')]
            .find((x) => ((x.querySelector('.name') || {}).textContent || '') === nm);
          return r ? r.getAttribute('data-state') : null;
        }, target.name);
        check('点击停止后状态回到离线', after2 === 'off', String(after2));
      }
    }
  }

  console.log('\n== 可访问性 ==');
  const a11y = await page.evaluate(() => {
    const focusables = [...document.querySelectorAll('button:not(:disabled), input, a[href]')];
    const noOutline = focusables.filter((el) => {
      const s = getComputedStyle(el);
      return !s.outlineStyle || s.outlineStyle === 'none';
    }).length;
    // 注意：元素可能不存在（比如页面没渲染出来），所以要判空再取属性。
    // 直接 (el || {}).getAttribute(...) 会在 el 为 null 时抛 TypeError，
    // 而那个异常看起来像「检查脚本坏了」，掩盖了真正的问题（页面没数据）。
    const cnt = document.getElementById('count');
    return {
      h1: document.querySelectorAll('h1').length,
      live: document.querySelectorAll('[aria-live]').length,
      focusable: focusables.length,
      liveText: cnt ? (cnt.getAttribute('aria-label') || '') : '',
      rows: document.querySelectorAll('.row').length,
      noOutline,
    };
  });

  // 页面没渲染出数据时，后面所有断言都会连带失败 —— 与其刷一屏 FAIL，
  // 不如直接指出是登录/接口的问题。
  if (a11y.rows === 0) {
    console.log('\n  [!!] 页面一行都没渲染 —— 多半是登录失败或 token 不对。');
    console.log('       本脚本用 SDC_UI_TOKEN 环境变量登录，当前端口 ' + PORT + '。');
    console.log('       生产实例请这样跑： $env:SDC_UI_TOKEN="<真实token>"; node tools/ui-check.js 3099');
    await browser.close();
    process.exit(1);
  }

  check('有 h1', a11y.h1 === 1, a11y.h1);
  check('有 aria-live 区域', a11y.live >= 1, a11y.live);
  check('计数有无障碍标签', a11y.liveText.length > 0, a11y.liveText);

  // 逐个聚焦，确认 focus-visible 生效
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return null;
    const s = getComputedStyle(el);
    return { tag: el.tagName, outline: s.outlineStyle + ' ' + s.outlineWidth, hasVisible: s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0 };
  });
  check('Tab 可聚焦且轮廓可见', focused && focused.hasVisible, focused ? focused.tag : 'none');

  console.log('\n== 控制台 ==');
  check('无控制台错误', errors.length === 0, errors.slice(0, 3).join(' | ') || '0');

  await browser.close();
  console.log('\n' + (fail === 0 ? '全部 ' + pass + ' 项通过。' : pass + ' 通过, ' + fail + ' 失败。'));
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('失败: ' + e.message); process.exit(1); });
