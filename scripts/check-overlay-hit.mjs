#!/usr/bin/env node
/**
 * 浮层命中检查（可复用）。
 *
 * 为什么需要它：截图看不出来「浮层被后面的容器整块盖住」——两种情况下像素长得几乎一样，
 * 但后者点不动。这里用 `document.elementFromPoint` 做真实命中测试：
 * 打开浮层后取元素自身中心点（外加四角内缩 8px 的点），断言命中的是元素自己或它的子元素；
 * 失败时同时打印 `elementsFromPoint` 里第一个不是自己/子元素的节点，直接看出是谁盖住了谁。
 *
 * 用法：
 *   node scripts/check-overlay-hit.mjs
 *   npm run check:overlays
 *
 * 环境变量：
 *   WB_BASE      被测地址，默认 http://127.0.0.1:5173（Vite dev server）
 *   WB_EMAIL     已有账号；与 WB_PASSWORD 都不填时，脚本自动注册 overlay-check-<时间戳>@example.com
 *   WB_PASSWORD  对应密码
 *   WB_HEADFUL   设为 1 打开有头浏览器，方便肉眼对照
 *   CHROME_PATH  浏览器可执行文件；缺省按 Chrome → Edge 顺序探测
 *
 * 覆盖场景（登录后 `/boards`）：
 *   - 1440 / 1024：顶栏空间切换器下拉 `.wb-space-menu`（每个空间项、新建、空态、空间设置入口）
 *   - 390：底部床单 `.wb-space-sheet`（完成按钮、空间项）
 *   - 三视口：`.wb-space-settings` 成员设置弹窗（成员行、邀请角色、生成邀请链接、链接上的复制/撤销）
 *
 * 任一检查失败 → 进程退出码 1，可直接挂在 CI / 发布前验收。
 */

import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const BASE = (process.env.WB_BASE ?? 'http://127.0.0.1:5173').replace(/\/+$/, '');
const EMAIL = process.env.WB_EMAIL?.trim() ?? '';
const PASSWORD = process.env.WB_PASSWORD ?? '';
const HEADFUL = process.env.WB_HEADFUL === '1';
const OUT = path.resolve('.verify/overlay');

const VIEWPORTS = [
  { name: '1440', width: 1440, height: 900, mobile: false },
  { name: '1024', width: 1024, height: 768, mobile: false },
  { name: '390', width: 390, height: 844, mobile: true },
];

function findBrowser() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error('找不到 Chrome / Edge，请用 CHROME_PATH 指定可执行文件');
  return found;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 在页面里跑命中测试。specs: [{ label, selector, all? }]
 * 返回每个元素：是否找到 / 是否有尺寸 / 中心点与四角内缩点是否命中自己。
 * `cover` 是压在最上面的「外人」，用来指认遮挡者。
 */
function probeInPage(specs) {
  const describe = (el) => {
    if (!el) return null;
    const cls = typeof el.className === 'string' && el.className.trim()
      ? `.${el.className.trim().split(/\s+/).join('.')}`
      : '';
    const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 20);
    return `${el.tagName.toLowerCase()}${cls}${text ? ` 「${text}」` : ''}`;
  };

  const checkPoint = (el, x, y) => {
    if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) {
      return { x, y, ok: false, cover: '视口外', outOfViewport: true };
    }
    const hit = document.elementFromPoint(x, y);
    const ok = !!hit && (hit === el || el.contains(hit));
    if (ok) return { x, y, ok: true };
    // 第一个不是自己 / 后代的节点就是遮挡者
    const stack = document.elementsFromPoint(x, y);
    const cover = stack.find((node) => node !== el && !el.contains(node) && !node.contains(el));
    return { x, y, ok: false, cover: describe(cover) ?? describe(hit) };
  };

  const results = [];
  for (const spec of specs) {
    const nodes = spec.all
      ? Array.from(document.querySelectorAll(spec.selector))
      : [document.querySelector(spec.selector)].filter(Boolean);
    if (nodes.length === 0) {
      results.push({ label: spec.label, selector: spec.selector, found: false });
      continue;
    }
    nodes.forEach((el, index) => {
      const label = spec.all ? `${spec.label}[${index}]` : spec.label;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        results.push({
          label,
          selector: spec.selector,
          found: true,
          visible: false,
          rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
        });
        return;
      }
      const inset = Math.min(8, Math.max(1, Math.floor(Math.min(rect.width, rect.height) / 4)));
      const points = {
        center: checkPoint(el, Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2)),
        'top-left': checkPoint(el, Math.round(rect.left + inset), Math.round(rect.top + inset)),
        'top-right': checkPoint(el, Math.round(rect.right - inset), Math.round(rect.top + inset)),
        'bottom-left': checkPoint(el, Math.round(rect.left + inset), Math.round(rect.bottom - inset)),
        'bottom-right': checkPoint(el, Math.round(rect.right - inset), Math.round(rect.bottom - inset)),
      };
      const failures = Object.entries(points).filter(([, point]) => !point.ok);
      results.push({
        label,
        selector: spec.selector,
        found: true,
        visible: true,
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        points,
        ok: failures.length === 0,
        cover: failures[0]?.[1]?.cover ?? null,
        failedPoints: failures.map(([name]) => name),
      });
    });
  }
  return results;
}

/** 命中通过后，用真实鼠标点元素中心；命中被挡时不做点击，避免连锁误报。 */
async function tap(page, selector, label) {
  const point = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  }, selector);
  if (!point) throw new Error(`${label}: 元素不可见 (${selector})`);
  await page.mouse.click(point.x, point.y);
  return point;
}

/* ------------------------------------------------------------------ */

const problems = [];
const summary = [];

function record(viewport, scene, results) {
  for (const item of results) {
    const ok = item.found !== false && item.visible !== false && item.ok !== false;
    if (!ok) {
      problems.push({
        viewport,
        scene,
        label: item.label,
        selector: item.selector,
        reason: item.found === false
          ? '元素不存在'
          : item.visible === false
            ? '元素尺寸为 0（不可见）'
            : `命中的是别的元素：${item.cover ?? '未知'}（失败点：${item.failedPoints.join(', ')}）`,
      });
    }
  }
  summary.push({
    viewport,
    scene,
    total: results.length,
    failed: results.filter((item) => !(item.found !== false && item.visible !== false && item.ok !== false)).length,
  });
}

async function openSwitcher(page, viewport) {
  await page.click('[data-testid="space-switcher"]');
  const panel = viewport.mobile ? '.wb-space-sheet' : '.wb-space-menu';
  await page.waitForSelector(panel, { timeout: 5000 });
  await sleep(220); // 等开合过渡结束，避免量到动画中间态
  return panel;
}

async function panelSpecs(page, viewport) {
  const teams = await page.evaluate(() => {
    const el = document.querySelectorAll('[data-space-item]');
    return el.length;
  });
  const specs = [
    { label: '浮层本体', selector: viewport.mobile ? '.wb-space-sheet' : '.wb-space-menu' },
    { label: '空间项', selector: '[data-space-item]', all: true },
    { label: '新建团队空间', selector: '.wb-space-menu__new' },
    { label: '空间设置入口', selector: '.wb-space-menu__footlink' },
  ];
  if (viewport.mobile) specs.push({ label: '完成按钮', selector: '.wb-space-sheet__done' });
  if (teams === 0) specs.push({ label: '空态新建', selector: '.wb-space-menu__empty' });
  return specs;
}

async function runViewport(browser, viewport, ctx) {
  const page = await browser.newPage();
  await page.setViewport({
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    isMobile: viewport.mobile,
    hasTouch: viewport.mobile,
  });

  const reload = async () => {
    await page.goto(`${BASE}/boards`, { waitUntil: 'networkidle2', timeout: 45000 });
    await page.waitForSelector('[data-testid="space-switcher"]', { timeout: 20000 });
    await sleep(200);
  };

  /** 一个场景失败不该带走别的场景：记一条问题，重载页面继续下一个 */
  const scene = async (name, run) => {
    try {
      await run();
    } catch (err) {
      problems.push({
        viewport: viewport.name,
        scene: name,
        label: '交互失败',
        selector: '-',
        reason: String(err?.message ?? err).split('\n')[0],
      });
      summary.push({ viewport: viewport.name, scene: name, total: 1, failed: 1 });
      await reload().catch(() => undefined);
    }
  };

  await reload();

  // ---- 1. 空间切换器：开关 + 浮层命中 ----
  await scene('空间切换器浮层', async () => {
    await openSwitcher(page, viewport);
    const hits = await page.evaluate(probeInPage, await panelSpecs(page, viewport));
    record(viewport.name, '空间切换器浮层', hits);
    await page.screenshot({ path: path.join(OUT, `space-menu-${viewport.name}.png`) });
    await page.keyboard.press('Escape'); // 关掉，后面重新开
    await sleep(150);
  });

  // ---- 2. 选项可点：切到团队空间再切回个人空间 ----
  await scene('切换空间', async () => {
    await openSwitcher(page, viewport);
    await tap(page, `[data-space-item="${ctx.teamId}"]`, '团队空间选项');
    await page.waitForFunction(
      () => (new URLSearchParams(location.search).get('space') ?? '') !== '',
      { timeout: 15000 },
    );
    await sleep(400);
    const switchedTeam = await page.evaluate(() => new URLSearchParams(location.search).get('space'));

    await page.waitForSelector('[data-testid="space-switcher"]', { timeout: 10000 });
    await openSwitcher(page, viewport);
    await tap(page, `[data-space-item="${ctx.personalId}"]`, '个人空间选项');
    await page.waitForFunction(
      () => (new URLSearchParams(location.search).get('space') ?? '') === '',
      { timeout: 15000 },
    );
    await sleep(400);
    const switchedBack = await page.evaluate(() => new URLSearchParams(location.search).get('space') ?? '');
    const pass = switchedTeam === ctx.teamId && switchedBack === '';
    summary.push({ viewport: viewport.name, scene: '切换空间', total: 2, failed: pass ? 0 : 2 });
    if (!pass) {
      problems.push({
        viewport: viewport.name,
        scene: '切换空间',
        label: '空间选项点击',
        selector: '[data-space-item]',
        reason: `切换后 URL 不符：团队=${switchedTeam ?? 'null'}，个人=${switchedBack || 'null'}`,
      });
    }
  });

  // ---- 3. 成员设置 + 邀请链接 ----
  await scene('成员设置弹窗', async () => {
    await openSwitcher(page, viewport);
    await tap(page, '.wb-space-menu__footlink', '空间设置入口');
    await page.waitForSelector('.wb-space-settings', { timeout: 10000 });
    await sleep(400); // 等成员列表请求回来
    const settingsHits = await page.evaluate(probeInPage, [
      { label: '设置弹窗', selector: '.wb-space-settings' },
      { label: '成员列表', selector: '.wb-space-members' },
      { label: '成员行', selector: '.wb-space-members__row', all: true },
      { label: '邀请角色选择', selector: '.wb-space-invite__role select' },
      { label: '生成邀请链接按钮', selector: '.wb-space-invite .wb-btn--primary' },
      { label: '关闭按钮', selector: '.wb-space-settings__head .wb-btn' },
    ]);
    record(viewport.name, '成员设置弹窗', settingsHits);

    const settingsOk = settingsHits.every(
      (item) => item.found !== false && item.visible !== false && item.ok !== false,
    );
    if (!settingsOk) {
      summary.push({ viewport: viewport.name, scene: '邀请链接', total: 0, failed: 0, skipped: true });
      await page.screenshot({ path: path.join(OUT, `space-settings-${viewport.name}.png`) });
      return;
    }

    await tap(page, '.wb-space-invite .wb-btn--primary', '生成邀请链接');
    await page.waitForSelector('.wb-space-invite__link', { timeout: 10000 });
    await sleep(200);
    const linkHits = await page.evaluate(probeInPage, [
      { label: '邀请链接', selector: '.wb-space-invite__link' },
      { label: '链接文本', selector: '.wb-space-invite__link code' },
      { label: '复制 / 撤销按钮', selector: '.wb-space-invite__link .wb-btn', all: true },
    ]);
    record(viewport.name, '邀请链接', linkHits);
    await page.screenshot({ path: path.join(OUT, `space-settings-${viewport.name}.png`) });
    await tap(page, '.wb-space-settings__head .wb-btn', '关闭设置');
    await page.waitForFunction(() => !document.querySelector('.wb-space-settings'), { timeout: 5000 });
  });

  await page.close();
}

/* ------------------------------------------------------------------ */

fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: findBrowser(),
  headless: HEADFUL ? false : 'new',
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1'],
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
});

try {
  const page = await browser.newPage();
  await page.goto(`${BASE}/boards`, { waitUntil: 'networkidle2', timeout: 45000 });

  // 登录：已有会话直接用；没有就用环境变量账号；都没有就临时注册一个
  const login = await page.evaluate(async (email, password) => {
    const me = await fetch('/api/auth/me');
    if (me.ok) {
      const data = await me.json();
      return { ok: true, method: 'session', email: data.user?.email ?? null };
    }
    if (!email || !password) return { ok: false, reason: '匿名且未提供 WB_EMAIL / WB_PASSWORD' };
    const loginRes = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (loginRes.ok) return { ok: true, method: 'login', email };
    const registerRes = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, displayName: '浮层验收' }),
    });
    if (registerRes.ok) return { ok: true, method: 'register', email };
    return { ok: false, reason: `登录 ${loginRes.status} / 注册 ${registerRes.status}` };
  }, EMAIL || `overlay-check-${Date.now()}@example.com`, PASSWORD || 'Overlay-Check-2026!');

  if (!login.ok) throw new Error(`无法登录：${login.reason}`);

  // 有一个团队空间才能验证「选项真的能点」；没有就建一个
  const ctx = await page.evaluate(async () => {
    const list = async () => (await (await fetch('/api/spaces')).json()).spaces;
    let spaces = await list();
    if (!spaces.some((space) => space.kind === 'team')) {
      await fetch('/api/spaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '浮层验收空间' }),
      });
      spaces = await list();
    }
    return {
      personalId: spaces.find((space) => space.kind === 'personal')?.id ?? '',
      teamId: spaces.find((space) => space.kind === 'team')?.id ?? '',
    };
  });
  if (!ctx.personalId || !ctx.teamId) throw new Error(`空间不完整：${JSON.stringify(ctx)}`);
  await page.close();

  for (const viewport of VIEWPORTS) {
    await runViewport(browser, viewport, ctx);
  }
} finally {
  await browser.close();
}

const failed = problems.length;
console.log(JSON.stringify({ base: BASE, viewports: summary, problems }, null, 2));
if (failed > 0) {
  console.error(`\n浮层命中检查失败：${failed} 项被遮挡或不可点`);
  process.exit(1);
}
console.log('\n浮层命中检查通过：三视口浮层中心点均命中自身');
