import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerGuest, registerUser } from "../lib/api.mjs";
import { assert, eq, finish, sleep, test, until } from "../lib/harness.mjs";
import { launchBrowser, newPage } from "../lib/browser.mjs";
import { closePool, opsCount } from "../lib/db.mjs";
import { WEB } from "../lib/config.mjs";

const spec = "export";

async function openBoard(page, boardId, suffix = "") {
  await page.goto(`${WEB}/board/${boardId}${suffix}`, { waitUntil: "networkidle2" });
  await page.waitForSelector(".excalidraw__canvas.interactive", { timeout: 25_000 });
  await until(
    async () =>
      page.evaluate(() => {
        const el = document.querySelector('[data-testid="export-open"]');
        return Boolean(el) && !el.disabled;
      }),
    { label: "导出入口可用", timeout: 20_000 },
  );
  await sleep(800);
}

async function draw(page, dx = 0, dy = 0) {
  const canvas = await page.$(".excalidraw__canvas.interactive");
  const box = await canvas.boundingBox();
  const cx = box.x + box.width / 2 + dx;
  const cy = box.y + box.height / 2 + dy;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(150);
  await page.keyboard.press("r");
  await page.mouse.move(cx - 90, cy - 60);
  await page.mouse.down();
  for (let step = 1; step <= 6; step += 1) {
    await page.mouse.move(cx - 90 + (step * 180) / 6, cy - 60 + (step * 120) / 6);
    await sleep(25);
  }
  await page.mouse.up();
  await sleep(800);
}

/** 打开浏览器下载到临时目录（headless 默认会静默丢弃 blob 下载） */
async function enableDownloads(page) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-export-"));
  const client = await page.target().createCDPSession();
  await client.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: dir });
  return dir;
}

/** 等某个扩展名的文件落盘并稳定（Chrome 先写 .crdownload 再改名） */
async function waitDownload(dir, ext, { timeout = 25_000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const name = fs.readdirSync(dir).find((item) => item.endsWith(ext));
    if (name) {
      const file = path.join(dir, name);
      const first = fs.statSync(file).size;
      await sleep(250);
      const second = fs.statSync(file).size;
      if (first > 0 && first === second) return { name, file, size: second };
    }
    await sleep(250);
  }
  throw new Error(`等待下载超时（${ext}）：${fs.readdirSync(dir).join(", ") || "目录为空"}`);
}

async function exportFile(page, format) {
  await page.click('[data-testid="export-open"]');
  await page.waitForSelector(`[data-testid="export-${format}"]`, { timeout: 10_000 });
  await page.click(`[data-testid="export-${format}"]`);
}

async function noticeText(page) {
  await page.waitForSelector('[data-testid="image-notice"]', { timeout: 20_000 });
  return page.$eval('[data-testid="image-notice"]', (node) => node.textContent ?? "");
}

/** 顶栏当前显示的板名：直接当文件名前缀，避免依赖本机最近打开记录 */
async function shownTitle(page) {
  return page.$eval(".wb-board__name", (node) => (node.textContent ?? "").trim());
}

/** 与 exportPlan.sanitizeExportTitle 同口径的前缀（只用于断言，不复制完整实现） */
function titlePrefix(title) {
  return title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, 60).trim();
}

async function main() {
  const owner = await registerUser("export-owner");
  const board = await owner.api.createBoard({ title: "导出/测试板" });
  const boardId = board.json.id;

  const browser = await launchBrowser();
  try {
    await test("主菜单不再出现库自带的 Export / SaveAsImage", async () => {
      const { page, context } = await newPage(browser, { cookie: owner.api.sessionCookie, width: 1440, height: 950 });
      try {
        await openBoard(page, boardId);
        await page.click('[data-testid="main-menu-trigger"]');
        await page.waitForSelector(".dropdown-menu", { timeout: 10_000 });
        const text = await page.$eval(".dropdown-menu", (node) => node.textContent ?? "");
        assert(!/export image/i.test(text), `主菜单仍含 Export：${text.slice(0, 200)}`);
        assert(!/save as image/i.test(text), `主菜单仍含 SaveAsImage：${text.slice(0, 200)}`);
        await page.keyboard.press("Escape");
      } finally {
        await context.close();
      }
    });

    const { page, context } = await newPage(browser, { cookie: owner.api.sessionCookie, width: 1440, height: 950 });
    const dir = await enableDownloads(page);
    try {
      await openBoard(page, boardId);
      await draw(page);

      await test("PNG 导出：文件名带板名与时间戳，提示导出成功", async () => {
        const name = titlePrefix(await shownTitle(page));
        eq(name, "导出-测试板", "顶栏标题应取服务端板名（斜杠替换为 -）");
        await exportFile(page, "png");
        const file = await waitDownload(dir, ".png");
        assert(file.name.startsWith(`${name}-`), `文件名应以清洗后的板名开头：${file.name}`);
        assert(/-\d{8}-\d{4}\.png$/.test(file.name), `文件名应以「时间戳.png」收尾：${file.name}`);
        const head = fs.readFileSync(file.file).subarray(0, 8);
        eq([...head], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "PNG 魔数");
        const notice = await noticeText(page);
        assert(notice.includes("已导出 PNG"), `应提示导出成功：${notice}`);
      });

      await test("SVG 导出：白底、内容为 svg 文档", async () => {
        await exportFile(page, "svg");
        const file = await waitDownload(dir, ".svg");
        const svg = fs.readFileSync(file.file, "utf8");
        assert(svg.includes("<svg"), "应是 svg 文档");
        assert(svg.toLowerCase().includes("ffffff"), "导出背景应为白色");
        const notice = await noticeText(page);
        assert(notice.includes("已导出 SVG"), `应提示导出成功：${notice}`);
      });

      await test("只读分享链接同样可导出", async () => {
        const share = await owner.api.createShare(boardId, "read", 7);
        eq(share.status, 201, `建分享：${JSON.stringify(share.json)}`);
        await until(async () => (await opsCount(boardId)) > 0, { label: "元素落库", timeout: 20_000 });

        const reader = await newPage(browser, { width: 1280, height: 900 });
        const readonlyDir = await enableDownloads(reader.page);
        try {
          await reader.page.goto(`${WEB}/board/${boardId}?view=1#share=${share.json.token}`, {
            waitUntil: "networkidle2",
          });
          await reader.page.waitForSelector('[data-testid="readonly-badge"]', { timeout: 25_000 });
          await reader.page.waitForSelector(".excalidraw__canvas.interactive", { timeout: 25_000 });
          await until(
            async () =>
              reader.page.evaluate(() => {
                const el = document.querySelector('[data-testid="export-open"]');
                return Boolean(el) && !el.disabled;
              }),
            { label: "只读导出入口可用", timeout: 20_000 },
          );
          await exportFile(reader.page, "png");
          const file = await waitDownload(readonlyDir, ".png");
          assert(file.size > 0, "只读导出应生成文件");
        } finally {
          fs.rmSync(readonlyDir, { recursive: true, force: true });
          await reader.context.close();
        }
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      await context.close();
    }

    await test("空画布导出：不生成文件并提示", async () => {
      const empty = await owner.api.createBoard({ title: "空板" });
      const pageInfo = await newPage(browser, { cookie: owner.api.sessionCookie, width: 1280, height: 900 });
      const emptyDir = await enableDownloads(pageInfo.page);
      try {
        await openBoard(pageInfo.page, empty.json.id);
        await exportFile(pageInfo.page, "png");
        const notice = await noticeText(pageInfo.page);
        assert(notice.includes("画布还是空的"), `应提示空画布：${notice}`);
        await sleep(1500);
        eq(fs.readdirSync(emptyDir).length, 0, "空画布不应产生下载文件");
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
        await pageInfo.context.close();
      }
    });

    await test("游客同样可导出", async () => {
      const guest = await registerGuest();
      const pageInfo = await newPage(browser, { width: 1280, height: 900 });
      const guestDir = await enableDownloads(pageInfo.page);
      try {
        await openBoard(pageInfo.page, guest.firstBoard.id);
        await draw(pageInfo.page, 40, 40);
        await exportFile(pageInfo.page, "svg");
        const file = await waitDownload(guestDir, ".svg");
        assert(file.size > 0, "游客导出应生成文件");
      } finally {
        fs.rmSync(guestDir, { recursive: true, force: true });
        await pageInfo.context.close();
      }
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
