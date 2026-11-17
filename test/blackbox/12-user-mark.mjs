#!/usr/bin/env node
/**
 * 12 · 用户名前的用户标识（线性图标）
 *
 * 覆盖：
 * - 首页导航、我的白板顶栏、回收站顶栏三处都是 16px 线稿人像图标，位于用户名之前；
 * - 与「回收站」(15) /「退出登录」(16) 同一图标源（.wb-icon、1.5px 描边）、同一颜色 token，夜间自动跟随；
 * - 不再出现彩色字母圆底；头像 aria-hidden，可访问名仍由用户名承担；
 * - 白板编辑页不加；
 * - 不撑高导航/顶栏；1440 / 1024 / 390 不换行、不溢出。
 */
import { launchBrowser, newPage, openBoards, freezeClock } from "../lib/browser.mjs";
import { Api, uniqueEmail, registerUser } from "../lib/api.mjs";
import { WEB } from "../lib/config.mjs";
import { assert, eq, finish, test, until } from "../lib/harness.mjs";

const browser = await launchBrowser();

async function markFacts(page, hostSelector, userSelector, iconSelector) {
  return page.evaluate(
    (host, userSel, iconSel) => {
      const name = document.querySelector(userSel);
      if (!name) return null;
      const holder = name.closest(".wb-user-chip") ?? name.closest(".wb-home__account") ?? name;
      const mark = holder.querySelector('[data-testid="user-mark"]');
      const svg = mark?.querySelector("svg");
      const icon = iconSel ? document.querySelector(iconSel) : null;
      const iconSvg = icon?.querySelector("svg") ?? (icon?.tagName === "svg" ? icon : null);
      const hostEl = host ? document.querySelector(host) : null;
      const m = mark?.getBoundingClientRect();
      const s = svg?.getBoundingClientRect();
      const n = name.getBoundingClientRect();
      const ms = mark ? getComputedStyle(mark) : null;
      const ss = svg ? getComputedStyle(svg) : null;
      const is = iconSvg ? getComputedStyle(iconSvg) : null;
      const next = mark?.nextElementSibling;
      return {
        hasMark: Boolean(mark),
        mark: m ? { w: +m.width.toFixed(1), h: +m.height.toFixed(1), top: +m.top.toFixed(1) } : null,
        svg: s ? { w: +s.width.toFixed(1), h: +s.height.toFixed(1), top: +s.top.toFixed(1) } : null,
        markBg: ms?.backgroundColor ?? null,
        markRadius: ms?.borderRadius ?? null,
        markText: mark?.textContent.trim() ?? null,
        svgColor: ss?.color ?? null,
        svgStroke: ss?.strokeWidth ?? null,
        iconColor: is?.color ?? null,
        iconStroke: is?.strokeWidth ?? null,
        ariaHidden: mark?.getAttribute("aria-hidden") ?? null,
        beforeName: Boolean(next) && (next === name || next.contains(name) || name.contains(next)),
        centerDelta: m ? +Math.abs((m.top + m.height / 2) - (n.top + n.height / 2)).toFixed(2) : null,
        iconCenterDelta: s ? +Math.abs((s.top + s.height / 2) - (n.top + n.height / 2)).toFixed(2) : null,
        hostHeight: hostEl ? +hostEl.getBoundingClientRect().height.toFixed(1) : null,
        overflowX: document.documentElement.scrollWidth > window.innerWidth,
      };
    },
    hostSelector,
    userSelector,
    iconSelector,
  );
}

/**
 * 每个页面用独立上下文，用完立刻关掉。
 * 之前这里只取 page、不关 context，7 个页面连开会让 Chrome 一路堆 Excalidraw
 * 的 WebGL/画布内存，最后 OOM 或协议超时，后面的用例连选择器都等不到。
 */
async function withPage(options, run) {
  const { context, page } = await newPage(browser, options);
  try {
    return await run(page);
  } finally {
    await context.close();
  }
}

try {
  const cn = new Api("mark-cn");
  await cn.register(uniqueEmail("mark-cn"), "林小满");
  await cn.createBoard({ title: "标识验证板" });

  await test("首页导航：16px 线性用户图标在用户名前，无线稿圆底，不撑高导航", async () => {
    await withPage({ cookie: cn.sessionCookie }, async (page) => {
    await page.goto(WEB, { waitUntil: "networkidle2" });
    await page.waitForSelector('[data-testid="home-user"]', { timeout: 20_000 });
    const facts = await markFacts(page, ".wb-home__nav", '[data-testid="home-user"]');
    assert(facts?.hasMark, "首页导航应有用户图标");
    eq(facts.svg.w, 16, "图标宽");
    eq(facts.svg.h, 16, "图标高");
    assert(facts.beforeName, "图标应在用户名之前");
    eq(facts.markText, "", "不应再有字母文字");
    eq(facts.markBg, "rgba(0, 0, 0, 0)", "不应有底色圆");
    eq(facts.markRadius, "0px", "不应有圆形底");
    eq(facts.ariaHidden, "true", "装饰性图标应对读屏隐藏");
    assert(facts.iconCenterDelta <= 1, `图标与用户名中心差 ${facts.iconCenterDelta}px`);
    const without = await page.evaluate(() => {
      const mark = document.querySelector('[data-testid="home-user"] [data-testid="user-mark"]');
      mark.style.display = "none";
      const h = document.querySelector(".wb-home__nav").getBoundingClientRect().height;
      mark.style.display = "";
      return +h.toFixed(1);
    });
    assert(Math.abs(without - facts.hostHeight) <= 0.5, `导航高 ${facts.hostHeight} vs 去掉图标 ${without}`);
    await page.screenshot({ path: ".verify/shots/usermark-home-1440.png" });
    });
  });

  await test("我的白板顶栏：16px 图标与「回收站」「退出登录」同源同色", async () => {
    await withPage({ cookie: cn.sessionCookie }, async (page) => {
    await openBoards(page);
    const facts = await markFacts(page, ".wb-topbar", '[data-testid="boards-user"]', ".wb-trash__nav");
    assert(facts?.hasMark, "我的白板顶栏应有用户图标");
    eq(facts.svg.w, 16, "图标宽");
    eq(facts.svg.h, 16, "图标高");
    assert(facts.beforeName, "图标应在用户名之前");
    eq(facts.markText, "", "不应再有字母文字");
    eq(facts.markBg, "rgba(0, 0, 0, 0)", "不应有底色圆");
    eq(facts.hostHeight, 64, "顶栏高度（我的白板按设计稿 .mk-topbar 为 64）");
    eq(facts.svgColor, facts.iconColor, "图标颜色应与回收站图标一致");
    eq(facts.svgStroke, facts.iconStroke, "图标描边应与回收站图标一致");
    eq(await page.$eval('[data-testid="boards-user"]', (el) => el.textContent), "林小满", "用户名文本保持");
    eq(facts.overflowX, false, "1440 不应横向溢出");
    await page.screenshot({ path: ".verify/shots/usermark-boards-1440.png" });
    });
  });

  await test("回收站顶栏：图标同样 16px，夜间跟随主题变色", async () => {
    await withPage({ cookie: cn.sessionCookie }, async (page) => {
    await freezeClock(page, "2026-11-15T22:30:00+08:00");
    await page.goto(`${WEB}/boards/trash`, { waitUntil: "networkidle2" });
    await page.waitForSelector('[data-testid="trash-user"]', { timeout: 20_000 });
    await until(async () => page.evaluate(() => document.documentElement.dataset.theme === "night"), { label: "夜间主题" });
    const facts = await markFacts(page, ".wb-topbar", '[data-testid="trash-user"]', ".wb-trash__nav");
    assert(facts?.hasMark, "回收站顶栏应有用户图标");
    eq(facts.svg.w, 16, "图标宽");
    eq(facts.markText, "", "不应再有字母文字");
    eq(facts.hostHeight, 44, "顶栏高度");
    eq(facts.svgColor, facts.iconColor, "夜间颜色应与相邻图标一致");
    eq(facts.overflowX, false, "夜间不应横向溢出");
    await page.screenshot({ path: ".verify/shots/usermark-trash-night-1440.png" });
    });
  });

  await test("白板编辑页：不重复添加用户图标（右侧已有协作者头像栈）", async () => {
    const list = await cn.list();
    const boardId = list.json.boards[0]?.id;
    await withPage({ cookie: cn.sessionCookie }, async (page) => {
    await page.goto(`${WEB}/board/${boardId}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".wb-board__topbar", { timeout: 20_000 });
    eq(await page.$(".wb-board__topbar [data-testid='user-mark']"), null, "编辑页顶栏不应出现用户图标");
    });
  });

  await test("390：首页/我的白板/回收站都不换行、不溢出", async () => {
    const pages = [
      { url: WEB, wait: '[data-testid="home-user"]', user: '[data-testid="home-user"]' },
      { url: `${WEB}/boards`, wait: '[data-testid="boards-user"]', user: '[data-testid="boards-user"]' },
      { url: `${WEB}/boards/trash`, wait: '[data-testid="trash-user"]', user: '[data-testid="trash-user"]' },
    ];
    for (const item of pages) {
      await withPage({ cookie: cn.sessionCookie, width: 390, height: 844 }, async (page) => {
      await page.goto(item.url, { waitUntil: "networkidle2" });
      await page.waitForSelector(item.wait, { timeout: 20_000 });
      if (item.url === WEB) {
        await page.click(".wb-home__menu");
        await page.waitForFunction(
          () => document.querySelector('[data-testid="home-user"]')?.getBoundingClientRect().width > 0,
          { timeout: 5000 },
        );
      }
      const facts = await markFacts(page, null, item.user);
      assert(facts?.hasMark, `${item.url} 应有用户图标`);
      eq(facts.svg.w, 16, `${item.url} 图标宽`);
      eq(facts.overflowX, false, `${item.url} 不应横向溢出`);
      const oneLine = await page.$eval(item.user, (el) => el.getBoundingClientRect().height <= 24);
      assert(oneLine, `${item.url} 用户名不应换行成两行`);
      await page.screenshot({ path: `.verify/shots/usermark-390-${item.url.split("/").pop() || "home"}.png` });
      });
    }
  });

  await test("英文账号同样显示图标（不再有首字母差异）", async () => {
    const en = await registerUser("mark-en");
    await withPage({ cookie: en.api.sessionCookie }, async (page) => {
    await openBoards(page);
    eq(await page.$eval('[data-testid="boards-user"]', (el) => Boolean(el.closest(".wb-user-chip")?.querySelector('[data-testid="user-mark"] svg'))), true, "英文账号也有图标");
    });
  });
} finally {
  await browser.close();
}

finish("user-mark");
