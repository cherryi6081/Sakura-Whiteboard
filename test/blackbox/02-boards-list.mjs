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

    const user = await registerUser("list-15");
    for (let i = 0; i < 12; i += 1) await user.api.createBoard({ title: `L-${i + 1}` });
    const { page } = await newPage(browser, { cookie: user.api.sessionCookie, width: 1440, height: 950 });

    await test("12 张 1440×950：4 列 × 3 行、288 宽、铺满、无滚动", async () => {
      await openBoards(page);
      const m = await layoutMetrics(page);
      eq(m.columns, 4, "列数");
      eq(m.rows, 3, "行数");
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

    await test("13 张：第 4 行出现，1440×950 允许滚动", async () => {
      await user.api.createBoard({ title: "L-13" });
      await page.setViewport({ width: 1440, height: 950, deviceScaleFactor: 1 });
      await openBoards(page);
      const m = await layoutMetrics(page);
      eq(m.cardCount, 13, "卡片数");
      eq(m.columns, 4, "列数");
      eq(m.rows, 4, "行数");
      eq(m.verticalScroll, true, "13 张时页高超过视口");
      await page.screenshot({ path: screenshotPath("boards-13-1440x950") });
    });

    await test("15 张：15 张全部渲染、仍 4 列", async () => {
      for (let i = 0; i < 2; i += 1) await user.api.createBoard({ title: `L-${14 + i}` });
      await openBoards(page);
      const m = await layoutMetrics(page);
      eq(m.cardCount, 15, "卡片数");
      eq(m.columns, 4, "列数");
      eq(m.verticalScroll, true, "15 张时页面可滚");
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
      eq(order.length, 15, "选择态卡片数");
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
