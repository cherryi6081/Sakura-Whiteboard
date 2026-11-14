import puppeteer from "puppeteer-core";
import { CHROME, HEADLESS, WEB } from "./config.mjs";
import { screenshotPath } from "./harness.mjs";

const HOST = new URL(WEB).hostname;

export async function launchBrowser() {
  return puppeteer.launch({
    executablePath: CHROME,
    headless: HEADLESS ? "new" : false,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--font-render-hinting=none"],
    defaultViewport: null,
  });
}

/**
 * 新建一个隔离上下文（独立 cookie / IndexedDB）。
 * @param cookie Api.sessionCookie 形如 `wb_sess=...`
 */
export async function newPage(browser, { cookie = "", width = 1440, height = 950, reducedMotion = false } = {}) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  if (reducedMotion) {
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  }
  if (cookie) {
    const [name, value] = cookie.split("=");
    await page.setCookie({ name, value, domain: HOST, path: "/" });
  }
  page.on("pageerror", (error) => console.log(`[pageerror] ${error.message}`));
  return { context, page };
}

export async function openBoards(page, { width, height } = {}) {
  if (width && height) await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.goto(`${WEB}/boards`, { waitUntil: "networkidle2" });
  await Promise.race([
    page.waitForSelector('[data-testid="board-card"]', { timeout: 20_000 }),
    page.waitForSelector('[data-testid="boards-empty"]', { timeout: 20_000 }),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 250));
}

/** 读版式事实：列数、卡片宽高、网格总宽 vs 内容区、是否滚动、是否居中 */
export async function layoutMetrics(page) {
  return page.evaluate(() => {
    const grid = document.querySelector('[data-testid="boards-grid"]');
    if (!grid) throw new Error("找不到 boards-grid");
    const cards = [...grid.querySelectorAll('[data-testid="board-card"]')];
    const style = getComputedStyle(grid);
    const tracks = style.gridTemplateColumns.split(" ").filter(Boolean).map(Number.parseFloat);
    const rect = grid.getBoundingClientRect();
    const cardRect = cards[0]?.getBoundingClientRect();
    // 缩略图框始终存在（有图是 img，没图是线稿占位），量框比量 img 稳
    const thumb = cards[0]?.querySelector(".wb-board-card__thumb");
    const thumbImg = cards[0]?.querySelector("img");
    const thumbRect = thumb?.getBoundingClientRect();
    const rows = new Set(cards.map((card) => Math.round(card.getBoundingClientRect().top))).size;
    const lastBottom = Math.max(...cards.map((card) => card.getBoundingClientRect().bottom));
    const columns = tracks.length;
    const gridContent = rect.width - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
    const totalWidth = tracks.reduce((sum, item) => sum + item, 0) + Math.max(0, columns - 1) * 16;
    return {
      columns,
      tracks,
      rows,
      cardWidth: cardRect ? Math.round(cardRect.width) : 0,
      cardHeight: cardRect ? Math.round(cardRect.height) : 0,
      thumbWidth: thumbRect ? Math.round(thumbRect.width) : 0,
      thumbHeight: thumbRect ? Math.round(thumbRect.height) : 0,
      hasThumbImg: Boolean(thumbImg),
      gridWidth: Math.round(rect.width),
      gridContent: Math.round(gridContent),
      totalWidth: Math.round(totalWidth),
      sideLeft: Math.round(rect.left),
      cardCount: cards.length,
      verticalScroll: document.documentElement.scrollHeight > window.innerHeight + 1,
      lastBottom: Math.round(lastBottom),
      viewportHeight: window.innerHeight,
      ids: cards.map((card) => card.getAttribute("data-board-id")),
    };
  });
}

export async function boardIds(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="board-card"]')].map((card) => card.getAttribute("data-board-id")),
  );
}

/** 把浏览器时钟固定在某个时刻（含 +08:00 偏移） */
export async function freezeClock(page, iso) {
  const fixed = new Date(iso).getTime();
  await page.evaluateOnNewDocument((ms) => {
    const RealDate = Date;
    class FakeDate extends RealDate {
      constructor(...args) {
        if (args.length === 0) super(ms);
        else super(...args);
      }
      static now() {
        return ms;
      }
    }
    // eslint-disable-next-line no-global-assign
    window.Date = FakeDate;
  }, fixed);
}

/**
 * 截图并测量「文字 vs 背景」的真实像素对比度。
 *
 * 不用分位数：短标题（"T-4"）的字形像素可能不到裁剪区的 3%，分位数会整段落在背景上，
 * 得出「对比度 1」的假结论。这里改成直方图——出现最多的亮度当作背景，
 * 再在所有出现次数 ≥0.2%（且至少 3 像素）的亮度里挑与背景反差最大的作为文字色，
 * 取的是字形实心像素，不会被抗锯齿中间色稀释。
 */
export async function pixelContrast(page, selector, name) {
  const handle = await page.$(selector);
  if (!handle) throw new Error(`找不到 ${selector}`);
  const box = await handle.boundingBox();
  if (!box) throw new Error(`${selector} 没有尺寸`);
  const clip = {
    x: Math.max(0, Math.floor(box.x)),
    y: Math.max(0, Math.floor(box.y)),
    width: Math.max(1, Math.floor(box.width)),
    height: Math.max(1, Math.floor(box.height)),
  };
  const base64 = await page.screenshot({ clip, encoding: "base64" });
  await page.screenshot({ path: screenshotPath(name), clip });
  return page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const channel = (value) => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const histogram = new Map();
    let total = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const lum = 0.2126 * channel(pixels[i]) + 0.7152 * channel(pixels[i + 1]) + 0.0722 * channel(pixels[i + 2]);
      const key = Number(lum.toFixed(4));
      histogram.set(key, (histogram.get(key) ?? 0) + 1);
      total += 1;
    }
    const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    let bg = 0;
    let bgCount = -1;
    for (const [lum, count] of histogram) {
      if (count > bgCount) {
        bg = lum;
        bgCount = count;
      }
    }
    const floor = Math.max(3, Math.floor(total * 0.002));
    let best = { lum: bg, count: bgCount, contrast: 1 };
    for (const [lum, count] of histogram) {
      if (count < floor) continue;
      const ratio = contrast(lum, bg);
      if (ratio > best.contrast) best = { lum, count, contrast: ratio };
    }
    return {
      background: bg,
      text: best.lum,
      textPixels: best.count,
      total,
      contrast: Number(best.contrast.toFixed(2)),
    };
  }, base64);
}

/** 画布区域采样最主要颜色（用来确认 Excalidraw 仍是白底） */
export async function dominantColor(page, selector) {
  const handle = await page.$(selector);
  const box = await handle.boundingBox();
  const clip = {
    x: Math.floor(box.x + box.width * 0.3),
    y: Math.floor(box.y + box.height * 0.3),
    width: 80,
    height: 80,
  };
  const base64 = await page.screenshot({ clip, encoding: "base64" });
  return page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const counts = new Map();
    for (let i = 0; i < pixels.length; i += 4) {
      const key = `${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }, base64);
}
