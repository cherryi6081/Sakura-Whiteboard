import { registerUser } from "../lib/api.mjs";
import { assert, eq, finish, sleep, test, until } from "../lib/harness.mjs";
import { launchBrowser, newPage } from "../lib/browser.mjs";
import { closePool } from "../lib/db.mjs";
import { WEB } from "../lib/config.mjs";
import { screenshotPath } from "../lib/harness.mjs";

const spec = "thumb";

function readThumb(page, boardId) {
  return page.evaluate(
    (id) =>
      new Promise((resolve) => {
        const request = indexedDB.open("wb-cache", 2);
        request.onerror = () => resolve(null);
        request.onupgradeneeded = () => resolve(null);
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("thumbs")) {
            resolve(null);
            return;
          }
          const tx = db.transaction("thumbs", "readonly");
          const get = tx.objectStore("thumbs").get(id);
          get.onerror = () => resolve(null);
          get.onsuccess = async () => {
            const value = get.result;
            if (!value) {
              resolve(null);
              return;
            }
            let width = 0;
            let height = 0;
            if (value.blob) {
              try {
                const bitmap = await createImageBitmap(value.blob);
                width = bitmap.width;
                height = bitmap.height;
                bitmap.close?.();
              } catch {
                /* ignore */
              }
            }
            resolve({
              signature: value.signature,
              updatedAt: value.updatedAt,
              size: value.blob?.size ?? 0,
              type: value.blob?.type ?? "",
              width,
              height,
            });
          };
        };
      }),
    boardId,
  );
}

async function openBoard(page, boardId) {
  await page.goto(`${WEB}/board/${boardId}`, { waitUntil: "networkidle2" });
  await page.waitForSelector(".excalidraw__canvas", { timeout: 25_000 });
  await sleep(1200);
}

async function drawRectangle(page, offset = 0) {
  const canvas = await page.$(".excalidraw__canvas.interactive");
  assert(canvas, "找不到 Excalidraw 交互画布");
  const box = await canvas.boundingBox();
  const cx = box.x + box.width / 2 + offset;
  const cy = box.y + box.height / 2 + offset;
  // Excalidraw 的快捷键挂在它自己的容器上：先点一下画布拿到焦点，再按 r
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(150);
  await page.keyboard.press("r");
  await page.mouse.move(cx - 80, cy - 50);
  await page.mouse.down();
  for (let step = 1; step <= 6; step += 1) {
    await page.mouse.move(cx - 80 + (step * 160) / 6, cy - 50 + (step * 100) / 6);
    await sleep(20);
  }
  await page.mouse.up();
  await sleep(900);
}

async function goBack(page) {
  await page.click('[data-testid="board-back"]');
  await page.waitForSelector('[data-testid="board-card"], [data-testid="boards-empty"]', { timeout: 20_000 });
  await sleep(500);
}

async function main() {
  const user = await registerUser("thumb");
  const created = await user.api.createBoard({ title: "缩略图测试板" });
  const boardId = created.json.id;
  const browser = await launchBrowser();
  try {
    const { page } = await newPage(browser, { cookie: user.api.sessionCookie, width: 1440, height: 950 });

    await test("空板不写缩略图", async () => {
      await openBoard(page, boardId);
      await sleep(1800);
      eq(await readThumb(page, boardId), null, "空板不应有 thumb 记录");
      await goBack(page);
      eq(await readThumb(page, boardId), null, "返回列表后仍不应写入");
      const img = await page.$(`[data-board-id="${boardId}"] img`);
      eq(img, null, "卡片应回退线稿图标");
    });

    let firstThumb = null;
    await test("首次进板画一笔，返回即写入 640×400 WebP", async () => {
      await openBoard(page, boardId);
      await drawRectangle(page, 0);
      await goBack(page);
      firstThumb = await readThumb(page, boardId);
      assert(firstThumb, "应写入缩略图");
      eq([firstThumb.width, firstThumb.height], [640, 400], "缩略图尺寸");
      eq(firstThumb.type, "image/webp", "格式");
      assert(firstThumb.size > 1000, `体积 ${firstThumb.size}`);
      assert(firstThumb.signature.length > 0, "指纹");
      await page.screenshot({ path: screenshotPath("thumb-after-first-draw") });
    });

    await test("指纹一致不重拍：再次进出不改 updatedAt", async () => {
      const before = await readThumb(page, boardId);
      await openBoard(page, boardId);
      await sleep(1500);
      await goBack(page);
      const after = await readThumb(page, boardId);
      eq(after.signature, before.signature, "指纹不应变化");
      eq(after.updatedAt, before.updatedAt, "updatedAt 不应变化");
    });

    await test("编辑后再返回：指纹与画面都更新", async () => {
      const before = await readThumb(page, boardId);
      await openBoard(page, boardId);
      await drawRectangle(page, 120);
      await goBack(page);
      const after = await readThumb(page, boardId);
      assert(after.signature !== before.signature, "指纹应变化");
      assert(after.updatedAt > before.updatedAt, "updatedAt 应前进");
      assert(after.size !== before.size, "画面变化后体积应不同");
    });

    await test("跨设备（新上下文无本地图）：进板能补齐缩略图", async () => {
      const second = await newPage(browser, { cookie: user.api.sessionCookie, width: 1280, height: 900 });
      await second.page.goto(`${WEB}/boards`, { waitUntil: "networkidle2" });
      await second.page.waitForSelector('[data-testid="board-card"]', { timeout: 20_000 });
      eq(await readThumb(second.page, boardId), null, "新上下文一开始没有缩略图");
      await openBoard(second.page, boardId);
      await goBack(second.page);
      const thumb = await readThumb(second.page, boardId);
      assert(thumb, "进板后应补齐缩略图");
      eq([thumb.width, thumb.height], [640, 400], "补齐尺寸");
      await second.context.close();
    });

    await test("列表卡片显示缩略图（img src 为 blob）", async () => {
      const src = await page.$eval(`[data-board-id="${boardId}"] img`, (img) => img.getAttribute("src"));
      assert(src?.startsWith("blob:"), `缩略图 src：${src}`);
      const natural = await page.$eval(`[data-board-id="${boardId}"] img`, (img) => ({
        w: img.naturalWidth,
        h: img.naturalHeight,
      }));
      eq([natural.w, natural.h], [640, 400], "卡片加载的图片尺寸");
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
