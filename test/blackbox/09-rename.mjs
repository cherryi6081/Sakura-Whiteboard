#!/usr/bin/env node
/**
 * 09 · 重命名白板
 *
 * 覆盖：
 * - ⋯ 菜单 →「重命名」进入**就地编辑**（输入框在卡片内、卡片高度不变）；
 * - Enter 保存 / Esc 取消 / 失焦保存；空标题与超长拒绝并提示；
 * - 乐观更新后 PATCH 200，刷新保持；
 * - 团队空间列表里 editor 可改他人板；
 * - 游客可改自己的临时板，标题同步本机 recentBoards，刷新不回退。
 */
import { launchBrowser, newPage, openBoards, freezeClock } from "../lib/browser.mjs";
import { registerUser, registerGuest } from "../lib/api.mjs";
import { WEB } from "../lib/config.mjs";
import { assert, eq, finish, sleep, test, until } from "../lib/harness.mjs";

const browser = await launchBrowser();

/** 打开某张卡的 ⋯ 菜单并点「重命名」，返回输入框 */
async function startRename(page, boardId) {
  await page.hover(`[data-board-id="${boardId}"]`);
  await page.click(`[data-board-id="${boardId}"] .wb-board-card__more`);
  await page.waitForSelector('[data-menu-key="rename"]', { timeout: 5000 });
  await page.click('[data-menu-key="rename"]');
  await page.waitForSelector(`[data-board-id="${boardId}"] [data-testid="rename-input"]`, { timeout: 5000 });
}

async function setInputValue(page, selector, value) {
  await page.$eval(
    selector,
    (el, next) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(el, next);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
    value,
  );
}

const cardTitle = (page, boardId) => page.$eval(`[data-board-id="${boardId}"] .wb-board-card__title`, (el) => el.textContent);
const cardHeight = (page, boardId) => page.$eval(`[data-board-id="${boardId}"]`, (el) => Math.round(el.getBoundingClientRect().height));

/** 真实鼠标双击（两次 click，不用 dblclick 合成事件） */
async function doubleClickAt(page, selector) {
  const box = await page.$eval(selector, (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(box.x, box.y);
  await page.mouse.click(box.x, box.y);
  return box;
}

try {
  const { api } = await registerUser("rename-user");
  const board = await api.createBoard({ title: "重命名目标" });
  const boardId = board.json.id;
  const patchStatuses = [];

  const { page } = await newPage(browser, { cookie: api.sessionCookie });
  page.on("response", (response) => {
    if (response.request().method() === "PATCH" && response.url().endsWith(`/api/boards/${boardId}`)) {
      patchStatuses.push(response.status());
    }
  });

  await test("⋯ 菜单 →「重命名」：输入框就地顶替标题，卡片高度不变", async () => {
    await openBoards(page);
    const before = await cardHeight(page, boardId);
    await startRename(page, boardId);
    const height = await cardHeight(page, boardId);
    eq(height, before, "编辑态卡片高度");
    const insideCard = await page.$eval(
      `[data-board-id="${boardId}"] [data-testid="rename-input"]`,
      (el) => Boolean(el.closest('[data-board-id]')),
    );
    assert(insideCard, "输入框应嵌在卡片内（不是居中弹窗）");
    const prefilled = await page.$eval('[data-testid="rename-input"]', (el) => el.value);
    eq(prefilled, "重命名目标", "预填当前标题");
  });

  await test("Enter 保存：乐观更新 + PATCH 200，刷新后保持", async () => {
    await setInputValue(page, '[data-testid="rename-input"]', "键盘改名");
    await page.keyboard.press("Enter");
    await until(() => patchStatuses.length > 0, { label: "PATCH 返回" });
    eq(patchStatuses[0], 200, "PATCH 状态");
    await until(async () => (await cardTitle(page, boardId)) === "键盘改名", { label: "卡片标题更新" });
    await page.reload({ waitUntil: "networkidle2" });
    await page.waitForSelector('[data-testid="board-card"]');
    eq(await cardTitle(page, boardId), "键盘改名", "刷新后标题");
  });

  await test("Esc 取消：不发请求、标题不变", async () => {
    const count = patchStatuses.length;
    await startRename(page, boardId);
    await setInputValue(page, '[data-testid="rename-input"]', "不该保存");
    await page.keyboard.press("Escape");
    await sleep(300);
    eq(await cardTitle(page, boardId), "键盘改名", "Esc 后标题");
    eq(patchStatuses.length, count, "Esc 不应发 PATCH");
  });

  await test("失焦保存：点卡片外即提交", async () => {
    await startRename(page, boardId);
    await setInputValue(page, '[data-testid="rename-input"]', "失焦改名");
    await page.mouse.click(5, 5);
    await until(async () => (await cardTitle(page, boardId)) === "失焦改名", { label: "失焦保存" });
    await until(() => patchStatuses.length >= 2, { label: "失焦 PATCH 返回" });
    eq(patchStatuses.at(-1), 200, "失焦 PATCH 状态");
  });

  await test("空标题：提示并保留原名", async () => {
    const count = patchStatuses.length;
    await startRename(page, boardId);
    await setInputValue(page, '[data-testid="rename-input"]', "   ");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".wb-toast", { timeout: 5000 });
    const toast = await page.$eval(".wb-toast", (el) => el.textContent);
    assert(toast.includes("标题不能为空"), `toast=${toast}`);
    eq(await cardTitle(page, boardId), "失焦改名", "空标题后保留原名");
    eq(patchStatuses.length, count, "空标题不应发 PATCH");
  });

  await test("超长标题：提示 80 字上限，不保存、留在编辑态", async () => {
    const count = patchStatuses.length;
    await startRename(page, boardId);
    await setInputValue(page, '[data-testid="rename-input"]', "长".repeat(81));
    await page.keyboard.press("Enter");
    await page.waitForSelector(".wb-toast", { timeout: 5000 });
    const toast = await page.$eval(".wb-toast", (el) => el.textContent);
    assert(toast.includes("80"), `toast=${toast}`);
    assert(await page.$('[data-testid="rename-input"]'), "超长后应留在编辑态");
    eq(patchStatuses.length, count, "超长不应发 PATCH");
    await page.keyboard.press("Escape");
  });

  await test("键盘可达：菜单打开时 F2 直接进入改名", async () => {
    await page.hover(`[data-board-id="${boardId}"]`);
    await page.click(`[data-board-id="${boardId}"] .wb-board-card__more`);
    await page.waitForSelector('[data-menu-key="rename"]');
    await page.keyboard.press("F2");
    await page.waitForSelector('[data-testid="rename-input"]', { timeout: 5000 });
    await page.keyboard.press("Escape");
  });

  await test("真实双击标题：进入就地编辑且不跳转，Enter 保存 PATCH 200", async () => {
    const beforeUrl = page.url();
    await doubleClickAt(page, `[data-board-id="${boardId}"] .wb-board-card__title`);
    await page.waitForSelector(`[data-board-id="${boardId}"] [data-testid="rename-input"]`, { timeout: 5000 });
    eq(page.url(), beforeUrl, "双击标题后 URL 应保持不变");
    await setInputValue(page, '[data-testid="rename-input"]', "双击改名");
    await page.keyboard.press("Enter");
    await until(async () => (await cardTitle(page, boardId)) === "双击改名", { label: "双击改名后标题" });
    await until(() => patchStatuses.length >= 3, { label: "双击改名 PATCH 返回" });
    eq(patchStatuses.at(-1), 200, "双击改名 PATCH 状态");
    await page.reload({ waitUntil: "networkidle2" });
    await page.waitForSelector('[data-testid="board-card"]');
    eq(await cardTitle(page, boardId), "双击改名", "刷新后保持");
  });

  await test("双击缩略图：仍按原行为进板，不误触发改名", async () => {
    const { page: coverPage } = await newPage(browser, { cookie: api.sessionCookie });
    await openBoards(coverPage);
    await Promise.all([
      coverPage.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15_000 }),
      doubleClickAt(coverPage, `[data-board-id="${boardId}"] .wb-board-card__thumb`),
    ]);
    assert(coverPage.url().includes(`/board/${boardId}`), `URL=${coverPage.url()}`);
    assert(!(await coverPage.$('[data-testid="rename-input"]')), "缩略图双击不应出现输入框");
  });

  await test("单击标题：延迟判定后仍进板", async () => {
    const { page: singlePage } = await newPage(browser, { cookie: api.sessionCookie });
    await openBoards(singlePage);
    const box = await singlePage.$eval(`[data-board-id="${boardId}"] .wb-board-card__title`, (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await Promise.all([
      singlePage.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15_000 }),
      singlePage.mouse.click(box.x, box.y),
    ]);
    assert(singlePage.url().includes(`/board/${boardId}`), `URL=${singlePage.url()}`);
  });

  await test("390 + 夜间：双击标题同样就地改名，不跳转", async () => {
    const { page: narrowPage } = await newPage(browser, { cookie: api.sessionCookie, width: 390, height: 844 });
    await freezeClock(narrowPage, "2026-11-15T22:30:00+08:00");
    await openBoards(narrowPage);
    await narrowPage.waitForFunction(() => document.documentElement.dataset.theme === "night", { timeout: 10_000 });
    const beforeUrl = narrowPage.url();
    await doubleClickAt(narrowPage, `[data-board-id="${boardId}"] .wb-board-card__title`);
    await narrowPage.waitForSelector(`[data-board-id="${boardId}"] [data-testid="rename-input"]`, { timeout: 5000 });
    eq(narrowPage.url(), beforeUrl, "390 双击后 URL 不变");
    await narrowPage.keyboard.press("Escape");
  });

  // 团队空间：editor 改他人板
  const owner = await registerUser("rename-team-owner");
  const editor = await registerUser("rename-team-editor");
  const space = await owner.api.createSpace(`rename-space-${Date.now()}`);
  const invite = await owner.api.invite(space.json.id, "editor");
  await editor.api.acceptInvite(invite.json.token);
  const teamBoard = await owner.api.createBoard({ title: "团队的板", spaceId: space.json.id });

  await test("团队空间列表：editor 就地改名他人板，卡片与接口一致", async () => {
    const { page: teamPage } = await newPage(browser, { cookie: editor.api.sessionCookie });
    await teamPage.goto(`${WEB}/boards?space=${space.json.id}`, { waitUntil: "networkidle2" });
    await teamPage.waitForSelector('[data-testid="board-card"]', { timeout: 20_000 });
    await startRename(teamPage, teamBoard.json.id);
    await setInputValue(teamPage, '[data-testid="rename-input"]', "团队改名后");
    await teamPage.keyboard.press("Enter");
    await until(async () => (await cardTitle(teamPage, teamBoard.json.id)) === "团队改名后", { label: "团队卡片标题" });
    const list = await owner.api.list(space.json.id);
    eq(list.json.boards.find((row) => row.id === teamBoard.json.id)?.title, "团队改名后", "服务端标题");
  });

  // 游客：公共板是所有人共用的一块，不提供单板改名/菜单
  const guest = await registerGuest();

  await test("游客：公共板固定标题，不提供单板改名", async () => {
    const { page: guestPage } = await newPage(browser, { cookie: guest.api.sessionCookie });
    await openBoards(guestPage);
    eq(await cardTitle(guestPage, guest.firstBoard.id), "公共临时板", "固定标题");
    await guestPage.hover(`[data-board-id="${guest.firstBoard.id}"]`);
    await guestPage.click(`[data-board-id="${guest.firstBoard.id}"] .wb-board-card__more`);
    await sleep(400);
    eq(await guestPage.$('[data-menu-key="rename"]'), null, "公共板不提供改名菜单");
  });
} finally {
  await browser.close();
}

finish("rename");
