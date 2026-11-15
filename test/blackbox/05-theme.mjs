import { registerUser } from "../lib/api.mjs";
import { assert, eq, finish, sleep, test } from "../lib/harness.mjs";
import { dominantColor, freezeClock, launchBrowser, newPage, pixelContrast } from "../lib/browser.mjs";
import { closePool } from "../lib/db.mjs";
import { WEB } from "../lib/config.mjs";
import { screenshotPath } from "../lib/harness.mjs";

const spec = "theme";

const AT = (hhmm) => `2026-11-13T${hhmm}:00+08:00`;

async function openWithClock(browser, cookie, iso, viewport = { width: 1440, height: 950 }) {
  const session = await newPage(browser, { cookie, ...viewport });
  await freezeClock(session.page, iso);
  await session.page.goto(`${WEB}/boards`, { waitUntil: "networkidle2" });
  await session.page.waitForSelector(".wb-page--boards", { timeout: 20_000 });
  await sleep(300);
  return session;
}

async function readTheme(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const style = getComputedStyle(root);
    return {
      period: root.dataset.period ?? null,
      theme: root.dataset.theme ?? null,
      shift: root.dataset.themeShift !== undefined,
      surfacePage: style.getPropertyValue("--surface-page").trim(),
      surfaceRaised: style.getPropertyValue("--surface-raised").trim(),
      inkStrong: style.getPropertyValue("--ink-strong").trim(),
      scrim: style.getPropertyValue("--scrim").trim(),
      themeDur: style.getPropertyValue("--theme-dur").trim(),
    };
  });
}

async function main() {
  const user = await registerUser("theme");
  for (let i = 0; i < 4; i += 1) await user.api.createBoard({ title: `T-${i + 1}` });
  const boardId = (await user.api.list()).json.boards[0].id;
  const browser = await launchBrowser();
  try {
    await test("四档 data-period / data-theme 正确", async () => {
      const cases = [
        ["06:30", "dawn", "light"],
        ["10:00", "day", "light"],
        ["18:30", "dusk", "light"],
        ["22:00", "night", "night"],
      ];
      for (const [time, period, theme] of cases) {
        const session = await openWithClock(browser, user.api.sessionCookie, AT(time));
        const state = await readTheme(session.page);
        eq([state.period, state.theme], [period, theme], `${time} 档位`);
        eq(state.shift, false, `${time} 初始不应有 shift 窗口`);
        if (time === "22:00") {
          await session.page.screenshot({ path: screenshotPath("theme-night-boards") });
        }
        await session.context.close();
      }
    });

    await test("19:00 前后：18:59 仍黄昏，19:00 切夜并开 3s 过渡窗口", async () => {
      const session = await newPage(browser, { cookie: user.api.sessionCookie, width: 1440, height: 950 });
      const page = session.page;
      await page.evaluateOnNewDocument(() => {
        window.__e2eNow = new Date("2026-11-13T18:59:40+08:00").getTime();
        const RealDate = Date;
        class FakeDate extends RealDate {
          constructor(...args) {
            if (args.length === 0) super(window.__e2eNow);
            else super(...args);
          }
          static now() {
            return window.__e2eNow;
          }
        }
        window.Date = FakeDate;
        const realSetInterval = window.setInterval.bind(window);
        window.setInterval = (fn, delay, ...rest) =>
          realSetInterval(fn, delay >= 30_000 ? 100 : delay, ...rest);
      });
      await page.goto(`${WEB}/boards`, { waitUntil: "networkidle2" });
      await page.waitForSelector(".wb-page--boards", { timeout: 20_000 });
      await sleep(400);
      eq((await readTheme(page)).period, "dusk", "18:59 应为黄昏");

      await page.evaluate(() => {
        window.__e2eNow = new Date("2026-11-13T19:00:05+08:00").getTime();
      });
      await sleep(500);
      const during = await readTheme(page);
      eq(during.period, "night", "19:00 应切到夜");
      eq(during.theme, "night", "19:00 data-theme");
      eq(during.shift, true, "跨档应开 data-theme-shift");
      const duration = await page.evaluate(() => {
        const node = document.querySelector(".wb-page");
        return getComputedStyle(node).transitionDuration;
      });
      assert(duration.includes("2.8s"), `过渡时长：${duration}`);
      await sleep(3200);
      eq((await readTheme(page)).shift, false, "3s 后应移除 shift");
      await session.context.close();
    });

    await test("reduce 下无候选过渡：matchMedia 生效、不设置 shift", async () => {
      const session = await newPage(browser, {
        cookie: user.api.sessionCookie,
        width: 1440,
        height: 950,
        reducedMotion: true,
      });
      await session.page.goto(`${WEB}/boards`, { waitUntil: "networkidle2" });
      await session.page.waitForSelector(".wb-page--boards", { timeout: 20_000 });
      const reduced = await session.page.evaluate(
        () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      );
      eq(reduced, true, "reduce 媒体查询应命中");
      eq((await readTheme(session.page)).shift, false, "reduce 下不应有 shift 窗口");
      await session.context.close();
    });

    await test("夜间换板：表面/文字/遮罩 token 与白天不同", async () => {
      const day = await openWithClock(browser, user.api.sessionCookie, AT("10:00"));
      const dayState = await readTheme(day.page);
      await day.context.close();
      const night = await openWithClock(browser, user.api.sessionCookie, AT("22:00"));
      const nightState = await readTheme(night.page);
      assert(dayState.surfacePage !== nightState.surfacePage, "surface-page 应变");
      assert(dayState.inkStrong !== nightState.inkStrong, "ink-strong 应变");
      assert(nightState.scrim.includes("0.8"), `夜间遮罩应 .8：${nightState.scrim}`);
      eq(nightState.themeDur, "2.8s", "过渡 token");
      await night.context.close();
    });

    await test("夜间关键文字像素对比度 ≥ 4.5（页面标题 / 卡片标题）", async () => {
      const session = await openWithClock(browser, user.api.sessionCookie, AT("22:00"));
      const pageTitle = await pixelContrast(session.page, ".wb-boards__titleline h1", "theme-night-title-pixels");
      const cardTitle = await pixelContrast(session.page, ".wb-board-card__title", "theme-night-card-title-pixels");
      assert(pageTitle.contrast >= 4.5, `页面标题对比度 ${JSON.stringify(pageTitle)}`);
      assert(cardTitle.contrast >= 4.5, `卡片标题对比度 ${JSON.stringify(cardTitle)}`);
      await session.context.close();
    });

    await test("夜间 Excalidraw 仍为白底岛", async () => {
      const session = await openWithClock(browser, user.api.sessionCookie, AT("22:00"));
      const page = session.page;
      await page.goto(`${WEB}/board/${boardId}`, { waitUntil: "networkidle2" });
      await page.waitForSelector(".excalidraw", { timeout: 25_000 });
      await sleep(1500);
      const state = await readTheme(page);
      eq(state.theme, "night", "编辑器夜间 data-theme");
      const color = await dominantColor(page, ".excalidraw");
      const [r, g, b] = color.split(",").map(Number);
      assert(r >= 245 && g >= 245 && b >= 245, `画布主色应接近白：${color}`);
      await page.screenshot({ path: screenshotPath("theme-night-excalidraw") });
      await session.context.close();
    });
    await test("空间设置下拉：自绘外壳随主题换色，尺寸不变、对比度 ≥ 4.5", async () => {
      const space = await user.api.createSpace(`theme-space-${Date.now()}`);
      const read = (page) =>
        page.evaluate(() => {
          const el = document.querySelector(".wb-space-invite__role select");
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          const rgb = (value) => value.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
          const lum = (value) => {
            const [r, g, b] = rgb(value).map((part) => {
              const c = part / 255;
              return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
            });
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
          };
          const fg = lum(style.color);
          const bg = lum(style.backgroundColor);
          const mark = document.querySelector(".wb-brand__mark");
          const markRect = mark.getBoundingClientRect();
          return {
            w: Math.round(rect.width),
            h: Math.round(rect.height),
            radius: style.borderRadius,
            appearance: style.appearance,
            bg: style.backgroundColor,
            color: style.color,
            contrast: Number(((Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)).toFixed(2)),
            brand: {
              tag: mark.tagName,
              alt: mark.getAttribute("alt"),
              text: document.querySelector(".wb-brand").textContent.trim(),
              w: Math.round(markRect.width),
              h: Math.round(markRect.height),
            },
          };
        });

      const open = async (session) => {
        const page = session.page;
        await page.goto(`${WEB}/boards?space=${space.json.id}`, { waitUntil: "networkidle2" });
        await page.waitForSelector(".wb-space-pill", { timeout: 20_000 });
        await page.click(".wb-space-pill");
        await page.waitForSelector(".wb-space-menu__footlink", { timeout: 5000 });
        for (const button of await page.$$(".wb-space-menu__footlink")) {
          if ((await button.evaluate((el) => el.textContent))?.includes("空间设置")) {
            await button.click();
            break;
          }
        }
        await page.waitForSelector(".wb-space-invite__role select", { timeout: 5000 });
        await sleep(400);
        return read(page);
      };

      const day = await openWithClock(browser, user.api.sessionCookie, AT("10:00"));
      const dayState = await open(day);
      await day.context.close();

      const night = await openWithClock(browser, user.api.sessionCookie, AT("22:00"));
      const nightState = await open(night);
      await night.context.close();

      eq(dayState.appearance, "none", "原生外观应关闭");
      eq(dayState.radius, "10px", "圆角沿用 radius token");
      eq(dayState.h, 44, "下拉高度");
      eq(nightState.h, dayState.h, "夜间高度不变");
      eq(nightState.w, dayState.w, "夜间宽度不变");
      assert(dayState.bg !== nightState.bg, `底色应随主题变化：${dayState.bg} / ${nightState.bg}`);
      assert(dayState.contrast >= 4.5, `白天对比度 ${dayState.contrast}`);
      assert(nightState.contrast >= 4.5, `夜间对比度 ${nightState.contrast}`);
      eq(dayState.brand.tag, "IMG", "品牌图标应为图片");
      eq(dayState.brand.alt, "", "装饰性图标 alt 应为空");
      eq(dayState.brand.text, "Sakura", "品牌文案");
      // 图标高度 26px，宽度按裁边后的原图等比（1470×1033）
      eq(dayState.brand.h, 26, "品牌图标高");
      eq(dayState.brand.w, 37, "品牌图标宽等比");
      eq(nightState.brand.h, dayState.brand.h, "夜间图标高度不变");
      eq(nightState.brand.w, dayState.brand.w, "夜间图标宽度不变");
    });

  } finally {
    await browser.close();
    await closePool();
  }
  finish(spec);
}

main().catch(async (error) => {
  console.error(error);
  await closePool().catch(() => {});
  process.exitCode = 1;
});
