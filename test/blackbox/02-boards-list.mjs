import { registerUser } from "../lib/api.mjs";
import { assert, eq, finish, near, test, until } from "../lib/harness.mjs";
import { launchBrowser, newPage, openBoards, layoutMetrics } from "../lib/browser.mjs";
import { closePool } from "../lib/db.mjs";
import { screenshotPath } from "../lib/harness.mjs";

const spec = "boards-list";

async function main() {
  const browser = await launchBrowser();
  try {
    const empty = await registerUser("list-empty");
    const { page: emptyPage } = await newPage(browser, { cookie: empty.api.sessionCookie, width: 1440, height: 950 });
    await test("0 张：空态出现，无卡片", async () => {
      await openBoards(emptyPage);
      const visible = await emptyPage.$('[data-testid="boards-empty"]');
      assert(visible, "应显示空态");
      const text = await emptyPage.$eval('[data-testid="boards-empty"]', (node) => node.textContent);
      assert(/还没有白板|第一块/.test(text), `空态文案：${text}`);
      eq(await emptyPage.$$eval('[data-testid="board-card"]', (nodes) => nodes.length), 0, "卡片数");
      await emptyPage.screenshot({ path: screenshotPath("boards-empty-1440x950") });
    });
    await emptyPage.close();

    const user = await registerUser("list-12");
    for (let i = 0; i < 12; i += 1) await user.api.createBoard({ title: `L-${i + 1}` });
    const { page } = await newPage(browser, { cookie: user.api.sessionCookie, width: 1440, height: 950 });

    await test("12 张 1440×950：4 列 × 3 行、288 宽、铺满、无滚动", async () => {
      await openBoards(page);
      const m = await layoutMetrics(page);
      eq(m.columns, 4, "列数");
      eq(m.rows, 3, "行数");
      eq(m.cardCount, 12, "12 张全部渲染，末位就是第 12 张");
      eq(await page.$('[data-testid="boards-more"]'), null, "12 张不出现占位格");
      near(m.cardWidth, 288, 2, "卡片宽度");
      near(m.totalWidth, m.gridContent, 2, "四列总宽 vs 内容区");
      eq(m.verticalScroll, false, "不应出现纵向滚动");
      assert(m.thumbWidth > 0 && m.thumbHeight > 0, "缩略图框应有尺寸");
      near(m.thumbWidth / m.thumbHeight, 1.6, 0.02, "缩略图 16:10");
      eq(m.hasThumbImg, false, "新板没有本地缩略图，回退线稿占位");
      await page.screenshot({ path: screenshotPath("boards-12-1440x950") });
    });

    await test("12 张 1440×768：4 列 288 宽、满宽但出现滚动", async () => {
      await page.setViewport({ width: 1440, height: 768, deviceScaleFactor: 1 });
      await until(async () => (await layoutMetrics(page)).columns === 4, { label: "resize 后 4 列" });
      const m = await layoutMetrics(page);
      eq(m.columns, 4, "列数");
      near(m.cardWidth, 288, 2, "卡片宽度");
      near(m.totalWidth, m.gridContent, 2, "四列总宽 vs 内容区");
      eq(m.verticalScroll, true, "1440×768 应滚动");
      await page.screenshot({ path: screenshotPath("boards-12-1440x768") });
    });

    await test("12 张 1024×768：4 列 201 宽、无滚动", async () => {
      await page.setViewport({ width: 1024, height: 768, deviceScaleFactor: 1 });
      await until(async () => (await layoutMetrics(page)).cardWidth < 230, { label: "卡片缩到 1024 档" });
      const m = await layoutMetrics(page);
      eq(m.columns, 4, "列数");
      near(m.cardWidth, 201, 2, "卡片宽度");
      eq(m.verticalScroll, false, "1024×768 不应滚动");
      await page.screenshot({ path: screenshotPath("boards-12-1024x768") });
    });

    await test("宽视口 1200 / 860：仍 4 列、四列铺满内容区", async () => {
      for (const width of [1200, 860]) {
        await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
        await until(async () => {
          const m = await layoutMetrics(page);
          return m.columns === 4 && Math.abs(m.totalWidth - m.gridContent) <= 2;
        }, { label: `${width} 下 4 列铺满` });
        const m = await layoutMetrics(page);
        eq(m.columns, 4, `${width} 列数`);
        near(m.totalWidth, m.gridContent, 2, `${width} 四列总宽`);
      }
    });

    await test("700 / 390：单列，卡片不超过容器", async () => {
      await page.setViewport({ width: 700, height: 900, deviceScaleFactor: 1 });
      await until(async () => (await layoutMetrics(page)).columns === 1, { label: "700 单列" });
      const at700 = await layoutMetrics(page);
      eq(at700.columns, 1, "700 列数");
      assert(at700.cardWidth <= 421, `700 卡片宽 ${at700.cardWidth}`);

      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
      await until(async () => (await layoutMetrics(page)).columns === 1, { label: "390 单列" });
      const at390 = await layoutMetrics(page);
      eq(at390.columns, 1, "390 列数");
      assert(at390.cardWidth <= 360, `390 卡片宽 ${at390.cardWidth}`);
      await page.screenshot({ path: screenshotPath("boards-12-390x844") });
    });

    await test("resize 实时生效：1440 → 390 → 1024", async () => {
      await page.setViewport({ width: 1440, height: 950, deviceScaleFactor: 1 });
      await until(async () => (await layoutMetrics(page)).columns === 4, { label: "回到 4 列" });
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
      await until(async () => (await layoutMetrics(page)).columns === 1, { label: "缩到单列" });
      await page.setViewport({ width: 1024, height: 768, deviceScaleFactor: 1 });
      await until(async () => {
        const m = await layoutMetrics(page);
        return m.columns === 4 && m.cardWidth < 230;
      }, { label: "恢复到 1024 档" });
    });

    await test("第 13 块：首屏 11 张 + 第 12 格占位，展开后 13 张 4 行", async () => {
      const created = await user.api.createBoard({ title: "L-13" });
      eq(created.status, 201, "第 13 块建板成功");
      await page.setViewport({ width: 1440, height: 950, deviceScaleFactor: 1 });
      await openBoards(page);

      // 首屏：11 张卡 + 1 个占位格，正好 12 格 3 行
      const first = await layoutMetrics(page);
      eq(first.cardCount, 11, "首屏卡片数");
      eq(first.columns, 4, "列数");
      eq(first.rows, 3, "首屏 12 格 = 3 行");
      eq(first.verticalScroll, false, "首屏不滚动");
      const more = await page.$eval('[data-testid="boards-more"]', (node) => ({
        text: node.textContent.replace(/\s+/g, " ").trim(),
        label: node.getAttribute("aria-label"),
        slot: [...node.parentElement.children].indexOf(node) + 1,
      }));
      assert(more.text.includes("还有 2 块白板"), `占位格应标注剩余 2 块：${more.text}`);
      eq(more.label, "展开剩余 2 块白板", "占位格无障碍文案");
      eq(more.slot, 12, "占位格落在第 12 格");
      const count = await page.$eval(".wb-boards__count", (node) => node.textContent.replace(/\s+/g, " ").trim());
      eq(count, "13 块", "计数始终显示总数");
      await page.screenshot({ path: screenshotPath("boards-13-collapsed-1440x950") });

      // 点占位格：13 张全部展开，不再有占位格
      await page.click('[data-testid="boards-more"]');
      await until(async () => (await page.$$('[data-testid="board-card"]')).length === 13, { label: "展开到 13 张" });
      const after = await layoutMetrics(page);
      eq(after.cardCount, 13, "展开后卡片数");
      eq(after.columns, 4, "列数");
      eq(after.rows, 4, "展开后 4 行");
      eq(after.verticalScroll, true, "超过一屏时页面可滚动");
      eq(await page.$('[data-testid="boards-more"]'), null, "全部展开后不再出现占位格");
      await page.screenshot({ path: screenshotPath("boards-13-expanded-1440x950") });
    });

    await test("12 ↔ 13 动态：删到 12 张占位格消失，补回 13 张占位格回来", async () => {
      // 上一条结束时是 13 张全部展开；删掉一块 → 总数 12，占位格不应再出现。
      const list = await user.api.list();
      const victim = list.json.boards.find((row) => row.title === "L-13");
      assert(victim, "应能找到 L-13");
      const removed = await user.api.removeBoard(victim.id);
      assert(removed.status < 300, `删除一块失败：${removed.status}`);

      await page.setViewport({ width: 1440, height: 950, deviceScaleFactor: 1 });
      await openBoards(page);
      eq((await layoutMetrics(page)).cardCount, 12, "12 张全部显示");
      eq(await page.$('[data-testid="boards-more"]'), null, "12 张不出现占位格");
      const count12 = await page.$eval(".wb-boards__count", (node) => node.textContent.replace(/\s+/g, " ").trim());
      eq(count12, "12 块", "计数「12 块」");
      await page.screenshot({ path: screenshotPath("boards-12-after-delete-1440x950") });

      // 补回第 13 块 → 首屏 11 张 + 第 12 格占位，剩余 2 块
      eq((await user.api.createBoard({ title: "L-13" })).status, 201, "补回第 13 块");
      await openBoards(page);
      eq((await layoutMetrics(page)).cardCount, 11, "13 张首屏 11 张");
      const slot = await page.$eval('[data-testid="boards-more"]', (node) => ({
        slot: [...node.parentElement.children].indexOf(node) + 1,
        text: node.textContent.replace(/\s+/g, " ").trim(),
      }));
      eq(slot.slot, 12, "占位格回到第 12 格");
      assert(slot.text.includes("还有 2 块白板"), `占位格剩余数量：${slot.text}`);
    });

    await test("30 块：占位格固定在 12 / 24 位，展开后不回缩", async () => {
      // 去掉上一条留下的置顶，让网格里只有卡片和占位格
      const now = await user.api.list();
      for (const board of now.json.boards.filter((row) => row.pinnedAt)) await user.api.pin(board.id, false);
      const extra = [];
      for (let i = 14; i <= 30; i += 1) extra.push(await user.api.createBoard({ title: `L-${i}` }));
      eq(extra.every((row) => row.status === 201), true, "补到 30 块");

      await page.setViewport({ width: 1440, height: 950, deviceScaleFactor: 1 });
      await openBoards(page);
      const tileSlot = () =>
        page.$eval('[data-testid="boards-more"]', (node) => ({
          slot: [...node.parentElement.children].indexOf(node) + 1,
          text: node.textContent.replace(/\s+/g, " ").trim(),
        }));

      eq((await layoutMetrics(page)).cardCount, 11, "首屏 11 张");
      eq((await tileSlot()).slot, 12, "占位格在 12 位");
      assert((await tileSlot()).text.includes("还有 19 块"), "首屏剩余 19 块");

      await page.click('[data-testid="boards-more"]');
      await until(async () => (await page.$$('[data-testid="board-card"]')).length === 23, { label: "第一次展开到 23 张" });
      eq((await layoutMetrics(page)).cardCount, 23, "第一次展开 23 张（不回缩）");
      eq((await tileSlot()).slot, 24, "第二次占位格在 24 位");
      assert((await tileSlot()).text.includes("还有 7 块"), "第二次剩余 7 块");
      const count = await page.$eval(".wb-boards__count", (node) => node.textContent.replace(/\s+/g, " ").trim());
      eq(count, "30 块", "展开过程中计数仍是总数");

      await page.click('[data-testid="boards-more"]');
      await until(async () => (await page.$$('[data-testid="board-card"]')).length === 30, { label: "第二次展开到 30 张" });
      eq(await page.$('[data-testid="boards-more"]'), null, "全部展开后占位格消失");
      eq((await layoutMetrics(page)).cardCount, 30, "30 张全部显示");
    });

    await test("置顶分组：出现「置顶 / 其余白板」两个分组，置顶在前", async () => {
      const list = await user.api.list();
      const ids = list.json.boards.map((board) => board.id);
      await user.api.pin(ids[ids.length - 1], true);
      await user.api.pin(ids[ids.length - 2], true);
      const afterPin = await user.api.list();
      await openBoards(page);
      const titles = await page.$$eval(".wb-boards__group-title", (nodes) =>
        nodes.map((node) => node.textContent.replace(/\s+/g, " ").trim()),
      );
      eq(titles.length, 2, "分组标题数");
      assert(titles[0].startsWith("置顶"), `第一组应为置顶：${titles[0]}`);
      assert(titles[1].startsWith("其余白板"), `第二组应为其余白板：${titles[1]}`);
      const firstTwo = await page.$$eval('[data-testid="board-card"]', (nodes) =>
        nodes.slice(0, 2).map((node) => node.getAttribute("data-board-id")),
      );
      // 置顶组内部按最近编辑倒序（契约：置顶优先 → lastEditedAt 倒序），以接口返回为准
      const pinnedRows = afterPin.json.boards
        .filter((board) => board.pinnedAt)
        .sort((a, b) => Date.parse(b.lastEditedAt) - Date.parse(a.lastEditedAt));
      eq(firstTwo, pinnedRows.map((board) => board.id), "置顶两块排在最前");
      eq(pinnedRows.length, 2, "置顶块数");
      await page.screenshot({ path: screenshotPath("boards-pinned-1440x950") });
    });

    await test("键盘方向键步长 = 列数（4 列 ↓ 前进 4）", async () => {
      await page.setViewport({ width: 1440, height: 950, deviceScaleFactor: 1 });
      await openBoards(page);
      await page.evaluate(() => {
        const button = [...document.querySelectorAll("button")].find((node) => node.textContent.trim() === "选择");
        if (!button) throw new Error("找不到「选择」按钮");
        button.click();
      });
      await until(async () => (await page.$('[data-select-check]')) !== null, { label: "进入选择态" });
      const order = await page.$$eval("[data-select-check]", (nodes) =>
        nodes.map((node) => node.getAttribute("data-select-check")),
      );
      eq(order.length, 11, "选择态首屏卡片数（11 张 + 占位格）");
      const activeCheck = () =>
        page.evaluate(() => document.activeElement?.getAttribute("data-select-check") ?? null);
      await page.focus(`[data-select-check="${order[0]}"]`);
      await page.keyboard.press("ArrowDown");
      // 焦点移动走 requestAnimationFrame，等它落定再断言，不靠固定延时
      await until(async () => (await activeCheck()) === order[4], { label: "↓ 前进 4 张" });
      eq(await activeCheck(), order[4], "↓ 应前进 4（四列）");
      await page.keyboard.press("ArrowUp");
      await until(async () => (await activeCheck()) === order[0], { label: "↑ 回到第 1 张" });
      eq(await activeCheck(), order[0], "↑ 应后退 4");

      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
      await until(async () => (await layoutMetrics(page)).columns === 1, { label: "单列" });
      await page.focus(`[data-select-check="${order[0]}"]`);
      await page.keyboard.press("ArrowDown");
      await until(async () => (await activeCheck()) === order[1], { label: "单列 ↓ 步长 1" });
      eq(await activeCheck(), order[1], "单列 ↓ 步长 1");
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
