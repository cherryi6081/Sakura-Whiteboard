import { registerUser } from "../lib/api.mjs";
import { assert, eq, finish, sleep, test, until } from "../lib/harness.mjs";
import { boardIds, launchBrowser, newPage, openBoards } from "../lib/browser.mjs";
import { closePool } from "../lib/db.mjs";

const spec = "drag";

function move(list, from, to) {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(Math.min(to, next.length), 0, item);
  return next;
}

/**
 * 落点下标按「拖拽中的实时预览」算：源卡行先被抽走，目标在剩余列表里的位置才是基准。
 * side = 指针落在目标卡中线右侧（after）还是左侧（before）。
 */
function dropPosition(current, sourceIndex, targetIndex, side) {
  const rest = current.filter((_, index) => index !== sourceIndex);
  const target = rest.indexOf(current[targetIndex]);
  return side === "after" ? target + 1 : target;
}

async function dragTo(page, sourceId, targetId, xRatio) {
  const source = await page.$(`[data-board-id="${sourceId}"]`);
  const target = await page.$(`[data-board-id="${targetId}"]`);
  assert(source && target, "找不到拖拽源或目标");
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  const startX = from.x + from.width / 2;
  const startY = from.y + from.height / 2;
  const endX = to.x + to.width * xRatio;
  const endY = to.y + to.height / 2;

  const patched = page.waitForResponse(
    (res) => res.url().includes("/order") && res.request().method() === "PATCH",
    { timeout: 10_000 },
  );
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(startX + ((endX - startX) * step) / 8, startY + ((endY - startY) * step) / 8);
    await sleep(30);
  }
  await page.mouse.up();
  const response = await patched;
  eq(response.status(), 200, "排序 PATCH 状态");
  await sleep(400);
}

async function main() {
  const user = await registerUser("drag");
  for (let i = 0; i < 12; i += 1) await user.api.createBoard({ title: `D-${i + 1}` });
  const browser = await launchBrowser();
  try {
    const { page } = await newPage(browser, { cookie: user.api.sessionCookie, width: 1440, height: 950 });
    await openBoards(page);
    const original = await boardIds(page);
    eq(original.length, 12, "初始卡片数");
    eq((await page.$$eval('[data-testid="boards-grid"] .wb-boards__group-title', (nodes) => nodes.length)), 0, "无置顶分组");

    await test("同行拖拽：0 → 第 1 张右侧，落点为 1", async () => {
      const expected = move(original, 0, dropPosition(original, 0, 1, "after"));
      await dragTo(page, original[0], original[1], 0.8);
      eq(await boardIds(page), expected, "同行落点顺序");
    });

    await test("跨行向下：第 1 行第 1 张 → 第 2 行右侧", async () => {
      const current = await boardIds(page);
      const source = current[0];
      const target = current[5];
      const expected = move(current, 0, dropPosition(current, 0, 5, "after"));
      await dragTo(page, source, target, 0.8);
      eq(await boardIds(page), expected, "跨行向下顺序");
    });

    await test("跨行向上：第 3 行 → 第 1 行左侧", async () => {
      const current = await boardIds(page);
      const source = current[9];
      const target = current[2];
      const expected = move(current, 9, dropPosition(current, 9, 2, "before"));
      await dragTo(page, source, target, 0.2);
      eq(await boardIds(page), expected, "跨行向上顺序");
    });

    await test("行间隙落点：拖到两行之间不跳错行、不报错", async () => {
      const current = await boardIds(page);
      const source = await page.$(`[data-board-id="${current[10]}"]`);
      const first = await page.$(`[data-board-id="${current[0]}"]`);
      const sourceBox = await source.boundingBox();
      const firstBox = await first.boundingBox();
      const rowHeight = sourceBox.height + 16;
      const gapY = firstBox.y + rowHeight * 2 - 8;

      const patched = page.waitForResponse(
        (res) => res.url().includes("/order") && res.request().method() === "PATCH",
        { timeout: 10_000 },
      );
      await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
      await page.mouse.down();
      for (let step = 1; step <= 8; step += 1) {
        await page.mouse.move(
          firstBox.x + firstBox.width / 2,
          sourceBox.y + sourceBox.height / 2 + ((gapY - (sourceBox.y + sourceBox.height / 2)) * step) / 8,
        );
        await sleep(30);
      }
      await page.mouse.up();
      const response = await patched;
      eq(response.status(), 200, "行间隙拖拽 PATCH 状态");
      await sleep(400);
      const after = await boardIds(page);
      assert(after[0] !== current[10], "应发生移动");
      eq(new Set(after).size, 12, "卡片不丢不重");
    });

    await test("刷新后顺序保持（服务端 manual 顺序）", async () => {
      const beforeReload = await boardIds(page);
      const apiList = await user.api.list();
      eq(apiList.json.sortMode, "manual", "首次拖拽后切换为手动顺序");
      eq(apiList.json.boards.map((board) => board.id), beforeReload, "API 顺序与界面一致");
      await openBoards(page);
      eq(await boardIds(page), beforeReload, "刷新后顺序不变");
    });

    await test("非法邻居：自己是邻居 → 400 INVALID_NEIGHBOR", async () => {
      const ids = await boardIds(page);
      const res = await user.api.order(ids[0], { beforeId: ids[0], afterId: ids[1] });
      eq(res.status, 400, "自邻居状态");
      eq(res.json?.error?.code, "INVALID_NEIGHBOR", "自邻居错误码");
    });

    await test("过期邻居：不存在的 id → 409 STALE_NEIGHBOR", async () => {
      const ids = await boardIds(page);
      // 12 位合法格式但库里不存在，走「邻居已不在」分支而不是 zod 校验
      const res = await user.api.order(ids[0], { beforeId: "zzzzzzzzzzzz", afterId: ids[1] });
      eq(res.status, 409, "未知邻居状态");
      eq(res.json?.error?.code, "STALE_NEIGHBOR", "未知邻居错误码");
    });

    await test("邻居被删后再提交 → 409 STALE_NEIGHBOR", async () => {
      const ids = await boardIds(page);
      const victim = ids[1];
      const removed = await user.api.removeBoard(victim);
      eq([204, 200].includes(removed.status), true, `删除邻居状态 ${removed.status}`);
      const res = await user.api.order(ids[0], { beforeId: victim, afterId: ids[2] ?? null });
      eq(res.status, 409, "已删邻居状态");
      eq(res.json?.error?.code, "STALE_NEIGHBOR", "已删邻居错误码");
      await user.api.restore(victim);
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
