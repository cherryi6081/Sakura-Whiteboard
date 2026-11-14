import { registerUser } from "../lib/api.mjs";
import { assert, eq, finish, sleep, test, until } from "../lib/harness.mjs";
import { launchBrowser, newPage } from "../lib/browser.mjs";
import { closePool, liveElements, opActors, opsCount } from "../lib/db.mjs";
import { WEB } from "../lib/config.mjs";

const spec = "editor";

async function openBoard(page, boardId) {
  await page.goto(`${WEB}/board/${boardId}`, { waitUntil: "networkidle2" });
  await page.waitForSelector(".excalidraw__canvas.interactive", { timeout: 25_000 });
  await sleep(1500);
}

async function draw(page, dx = 0, dy = 0) {
  const canvas = await page.$(".excalidraw__canvas.interactive");
  const box = await canvas.boundingBox();
  const cx = box.x + box.width / 2 + dx;
  const cy = box.y + box.height / 2 + dy;
  // Excalidraw 的快捷键挂在它自己的容器上：先点一下画布拿到焦点，再按 r
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

async function main() {
  const user = await registerUser("editor");
  const created = await user.api.createBoard({ title: "编辑页测试板" });
  const boardId = created.json.id;
  const browser = await launchBrowser();
  try {
    await test("进板、画一笔：op 落库且元素物化", async () => {
      const { page, context } = await newPage(browser, { cookie: user.api.sessionCookie, width: 1440, height: 950 });
      await openBoard(page, boardId);
      const before = await opsCount(boardId);
      await draw(page, 0, 0);
      await until(async () => (await opsCount(boardId)) > before, { label: "op 落库", timeout: 20_000 });
      const elements = await liveElements(boardId);
      eq(elements.length, 1, "物化元素数");
      eq(elements[0].type, "rectangle", "元素类型");
      await context.close();
    });

    await test("离线改动后回连补拉：恢复网络后 op 补齐", async () => {
      const { page, context } = await newPage(browser, { cookie: user.api.sessionCookie, width: 1440, height: 950 });
      await openBoard(page, boardId);
      const before = await opsCount(boardId);
      await page.setOfflineMode(true);
      await sleep(500);
      await draw(page, 60, 60);
      const offlineCount = await opsCount(boardId);
      eq(offlineCount, before, "离线期间不应有 op 落库");
      await page.setOfflineMode(false);
      await until(async () => (await opsCount(boardId)) > before, {
        label: "回连后 outbox 补齐",
        timeout: 40_000,
      });
      await context.close();
    });

    await test("多人同板并发写入：两人各画一笔，最终两块元素都在", async () => {
      const owner = await registerUser("editor-owner");
      const editor = await registerUser("editor-editor");
      const space = await owner.api.createSpace(`并发空间-${Date.now()}`);
      const spaceId = space.json.id;
      const invite = await owner.api.invite(spaceId, "editor");
      await editor.api.acceptInvite(invite.json.token);
      const board = await owner.api.createBoard({ title: "并发板", spaceId });
      const id = board.json.id;

      const a = await newPage(browser, { cookie: owner.api.sessionCookie, width: 1280, height: 900 });
      const b = await newPage(browser, { cookie: editor.api.sessionCookie, width: 1280, height: 900 });
      await openBoard(a.page, id);
      await openBoard(b.page, id);
      await draw(a.page, -120, 0);
      await draw(b.page, 120, 0);

      await until(async () => (await liveElements(id)).length >= 2, { label: "两块元素收敛", timeout: 30_000 });
      const elements = await liveElements(id);
      eq(elements.length, 2, "最终元素数");
      eq(new Set(elements.map((item) => item.type)).size, 1, "两块都是 rectangle");

      const snapshot = await owner.api.get(`/api/boards/${id}/snapshot`);
      eq(snapshot.status, 200, "快照可读");
      const snapshotCount = (snapshot.json.elements ?? snapshot.json.snapshot?.elements ?? []).filter(
        (item) => !item.isDeleted,
      ).length;
      eq(snapshotCount >= 2, true, `快照元素数 ${snapshotCount}`);

      eq(await opActors(id) >= 2, true, "两位作者的 op 都在");

      await a.context.close();
      await b.context.close();
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
