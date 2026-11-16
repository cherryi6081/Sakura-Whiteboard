import { registerUser } from "../lib/api.mjs";
import { WEB } from "../lib/config.mjs";
import { assert, eq, finish, screenshotPath, sleep, test, until } from "../lib/harness.mjs";
import { boardIds, launchBrowser, newPage, openBoards } from "../lib/browser.mjs";
import { closePool } from "../lib/db.mjs";

/**
 * 退出登录后的「我的白板」口径（v1.7）：
 * - 列表来源从服务端切回本机临时板，账号维度的列表/容量/空间/缩略图一帧都不留；
 * - 本机没有临时板 → 空态 + 新建 / 登录两个入口；
 * - 本机 `recentBoards` 与 IndexedDB `thumbs` 按身份隔离（游客 / user:<id>）；
 * - `/api/auth/me` 401、顶栏用户名位回到「登录」、容量计数 0 / 12；
 * - `/boards/trash` 这类受限页被既有守卫弹回登录页。
 */

const spec = "logout";

const LEGACY_KEY = "wb:recentBoards";
const GUEST_KEY = "wb:recentBoards:guest";

/** 在页面里逐帧记录列表的可见状态，用来证明退出瞬间没有旧账号内容闪现 */
async function watchFrames(page) {
  await page.evaluate(() => {
    const capture = () => {
      const cards = [...document.querySelectorAll('[data-testid="board-card"]')].map((node) =>
        node.getAttribute("data-board-id"),
      );
      window.__wbFrames.push({
        cards,
        user: document.querySelector('[data-testid="boards-user"]')?.textContent?.trim() ?? null,
        login: Boolean(document.querySelector('[data-testid="boards-login"]')),
        space: Boolean(document.querySelector('[data-testid="space-switcher"]')),
        trash: Boolean(document.querySelector('[data-testid="boards-trash-link"]')),
        empty: Boolean(document.querySelector('[data-testid="boards-empty"]')),
        count: document.querySelector(".wb-boards__count")?.textContent?.replace(/\s+/g, " ").trim() ?? null,
        at: Math.round(performance.now()),
      });
    };
    window.__wbFrames = [];
    capture();
    window.__wbObserver = new MutationObserver(capture);
    window.__wbObserver.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
  });
}

async function readFrames(page) {
  return page.evaluate(() => {
    window.__wbObserver?.disconnect();
    return window.__wbFrames;
  });
}

async function setSessionCookie(page, sessionCookie) {
  const [name, value] = sessionCookie.split("=");
  await page.setCookie({ name, value, url: WEB });
}

async function openHome(context, expectUser) {
  const page = await context.newPage();
  await page.goto(`${WEB}/`, { waitUntil: "networkidle2" });
  await page.waitForSelector(
    expectUser ? '[data-testid="home-user"]' : '[data-testid="home-login"]',
    { timeout: 20_000 },
  );
  return page;
}

async function logoutFromHome(homePage) {
  await homePage.click('[data-testid="home-user"]');
  await homePage.waitForSelector('[data-testid="home-logout"]', { timeout: 5_000 });
  await homePage.click('[data-testid="home-logout"]');
  await homePage.waitForSelector('[data-testid="home-login"]', { timeout: 15_000 });
}

async function storageKeys(page) {
  return page.evaluate(() => Object.keys(localStorage).sort());
}

async function thumbStoreInfo(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("wb-cache");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const tx = db.transaction("thumbs", "readonly");
    const store = tx.objectStore("thumbs");
    const records = await new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return { keyPath: store.keyPath, owners: [...new Set(records.map((item) => item.owner))].sort() };
  });
}

/** 在进板后的画布上画一个矩形：空白板没有元素就没有签名，不会产生缩略图 */
async function drawRectangle(page) {
  await page.waitForSelector(".excalidraw__canvas.interactive", { timeout: 30_000 });
  await sleep(900);
  const canvas = await page.$(".excalidraw__canvas.interactive");
  const box = await canvas.boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.click(cx, cy);
  await sleep(150);
  await page.keyboard.press("r");
  await page.mouse.move(cx - 80, cy - 50);
  await page.mouse.down();
  for (let step = 1; step <= 6; step += 1) {
    await page.mouse.move(cx - 80 + (step * 160) / 6, cy - 50 + (step * 100) / 6);
    await sleep(20);
  }
  await page.mouse.up();
  await sleep(1400);
}

async function main() {
  const browser = await launchBrowser();
  try {
    // ---------- 场景 A：登录态 12 块 → 退出（另一标签页点退出） ----------
    const user = await registerUser("logout-12");
    for (let i = 0; i < 12; i += 1) await user.api.createBoard({ title: `L-${i + 1}` });
    const { context, page: boardsPage } = await newPage(browser, {
      cookie: user.api.sessionCookie,
      width: 1440,
      height: 950,
    });
    await openBoards(boardsPage);
    // 12 块时首屏是 11 张 + 占位格：先展开再记录账号卡片
    if (await boardsPage.$('[data-testid="boards-more"]')) {
      await boardsPage.click('[data-testid="boards-more"]');
      await until(async () => (await boardIds(boardsPage)).length === 12, { label: "展开到 12 张" });
    }
    const oldIds = await boardIds(boardsPage);
    const home = await openHome(context, true);

    await test("登录态 12 块：用户名位 / 计数「12 块」/ 回收站入口都在", async () => {
      eq(oldIds.length, 12, "登录态卡片数");
      const me = await user.api.get("/api/auth/me");
      eq(me.status, 200, "/api/auth/me 应 200");
      const name = await boardsPage.$eval('[data-testid="boards-user"]', (node) => node.textContent.trim());
      eq(name, me.json.user.displayName, "顶栏用户名位");
      const count = await boardsPage.$eval(".wb-boards__count", (node) =>
        node.textContent.replace(/\s+/g, " ").trim(),
      );
      eq(count, "12 块", "登录账号计数不再固定 / 12");
      assert(await boardsPage.$('[data-testid="boards-trash-link"]'), "登录态应有回收站入口");
      await boardsPage.screenshot({ path: screenshotPath("logout-before-1440x950") });
    });

    await test("退出瞬间：首帧即游客视图，全程无旧账号内容", async () => {
      await watchFrames(boardsPage);
      await logoutFromHome(home);
      await boardsPage.waitForSelector('[data-testid="boards-login"]', { timeout: 15_000 });
      await until(async () => (await boardsPage.$('[data-testid="boards-empty"]')) !== null, { label: "游客空态" });
      const frames = await readFrames(boardsPage);
      const flip = frames.findIndex((frame) => frame.user === null);
      assert(flip >= 0, `应记录到退出后的帧，实得 ${frames.length} 帧`);
      const after = frames.slice(flip);
      assert(after.every((frame) => frame.user === null), "退出后不应再出现用户名");
      const leaked = after.flatMap((frame) => frame.cards).filter((id) => oldIds.includes(id));
      eq(leaked, [], "退出后任何一帧都不应出现旧账号的板");
      // 首帧证据：退出后的第一次 DOM 提交就是游客空态，容量归零
      const first = frames[flip];
      eq(first.empty, true, "退出首帧应为游客空态");
      eq(first.login, true, "退出首帧应显示登录入口");
      eq(first.space, false, "退出首帧应收掉空间胶囊");
      eq(first.trash, false, "退出首帧应收掉回收站入口");
      eq(first.count, "0 / 12", "退出首帧容量计数归零");
      console.log(
        `      首帧：${JSON.stringify(first)}\n      前 3 帧：${JSON.stringify(frames.slice(Math.max(0, flip - 1), flip + 2))}`,
      );
      // 本机没有游客临时板：空态要同时给「新建」和「登录」两个入口
      assert(await boardsPage.$('[data-testid="boards-empty-login"]'), "空态应有登录入口");
      const newButton = await boardsPage.$eval('[data-testid="boards-empty"]', (node) => node.textContent);
      assert(/新建第一块/.test(newButton), `空态应有新建入口：${newButton}`);
      await boardsPage.screenshot({ path: screenshotPath("logout-after-empty-1440x950") });
    });

    await test("退出后：/api/auth/me 401、用户名位回登录、容量计数与列表一致", async () => {
      const status = await boardsPage.evaluate(() => fetch("/api/auth/me").then((res) => res.status));
      eq(status, 401, "/api/auth/me");
      eq(await boardsPage.$('[data-testid="boards-user"]'), null, "不应再有顶栏用户名");
      assert(await boardsPage.$('[data-testid="boards-login"]'), "应显示「登录 / 注册」");
      eq(await boardsPage.$('[data-testid="boards-trash-link"]'), null, "游客不应有回收站入口");
      const count = await boardsPage.$eval(".wb-boards__count", (node) =>
        node.textContent.replace(/\s+/g, " ").trim(),
      );
      eq(count, "0 / 12", "容量计数");
      const keys = await storageKeys(boardsPage);
      assert(!keys.includes(LEGACY_KEY), `不应残留旧全局 key：${keys.join(",")}`);
      assert(
        keys.every((key) => !key.startsWith("wb:recentBoards:user:") || key !== "wb:recentBoards:user:"),
        "身份 key 需带 userId",
      );
    });

    await test("退出后刷新：仍是游客空态，不会因缓存回到登录态列表", async () => {
      await boardsPage.reload({ waitUntil: "networkidle2" });
      await boardsPage.waitForSelector('[data-testid="boards-login"]', { timeout: 15_000 });
      await boardsPage.waitForSelector('[data-testid="boards-empty"]', { timeout: 15_000 });
      eq(await boardIds(boardsPage), [], "刷新后卡片数");
      eq(await boardsPage.$('[data-testid="boards-user"]'), null, "刷新后不应出现用户名");
      const me = await boardsPage.evaluate(() => fetch("/api/auth/me").then((res) => res.status));
      eq(me, 401, "刷新后 /api/auth/me");
    });

    // ---------- 场景 B：游客建临时板 → 登录 → 退出（来回两次不串数据） ----------
    const guestShare = await registerUser("logout-guest-owner");
    const { context: guestContext, page: guestPage } = await newPage(browser, { width: 1440, height: 950 });
    await openBoards(guestPage);
    await guestPage.click('[data-testid="boards-new"]');
    await guestPage.waitForFunction(() => location.pathname.startsWith("/board/"), { timeout: 20_000 });
    // 空白板不会产生缩略图（没有元素就没有签名），先画一个矩形再退出
    await drawRectangle(guestPage);
    const guestBoardId = new URL(guestPage.url()).pathname.split("/").pop();
    await openBoards(guestPage);
    const home2 = await openHome(guestContext, false);

    await test("游客临时板写入游客 key，登录后不显示为账号的板", async () => {
      eq(await boardIds(guestPage), [guestBoardId], "游客卡片");
      const keys = await storageKeys(guestPage);
      assert(keys.includes(GUEST_KEY), `应有游客 key：${keys.join(",")}`);
      assert(!keys.some((key) => key.startsWith("wb:recentBoards:user:")), "不应生成账号 key");
      // 缩略图按身份落盘：刚打开过的游客板应写入 owner=guest 的记录
      await until(async () => (await thumbStoreInfo(guestPage)).owners.includes("guest"), {
        label: "游客缩略图写入",
      });

      await setSessionCookie(guestPage, guestShare.api.sessionCookie);
      await guestPage.reload({ waitUntil: "networkidle2" });
      await guestPage.waitForSelector('[data-testid="boards-user"]', { timeout: 20_000 });
      await until(async () => (await guestPage.$('[data-testid="boards-empty"]')) !== null, { label: "账号空态" });
      eq(await boardIds(guestPage), [], "登录后的账号列表不应包含游客板");
      const stillGuest = await storageKeys(guestPage);
      assert(stillGuest.includes(GUEST_KEY), "游客记录应原样保留");
      assert(!stillGuest.includes(LEGACY_KEY), "不应出现旧全局 key");
    });

    await test("首次退出：回到游客临时板，账号板不出现", async () => {
      const home3 = await openHome(guestContext, true);
      await watchFrames(guestPage);
      await logoutFromHome(home3);
      await until(async () => (await boardIds(guestPage)).length === 1, { label: "游客临时板回来" });
      eq(await boardIds(guestPage), [guestBoardId], "退出后应为游客那块板");
      const frames = await readFrames(guestPage);
      const flip = frames.findIndex((frame) => frame.user === null);
      assert(flip >= 0, "应记录到退出后的帧");
      assert(frames.slice(flip).every((frame) => frame.user === null), "退出后不应再出现用户名");
      const count = await guestPage.$eval(".wb-boards__count", (node) =>
        node.textContent.replace(/\s+/g, " ").trim(),
      );
      eq(count, "1 / 12", "容量计数回到游客");
      await guestPage.screenshot({ path: screenshotPath("logout-guest-1440x950") });
      await home3.close();
    });

    await test("再次登录再退出：两轮互不串数据，缩略图按身份隔离", async () => {
      const relog = await guestShare.api.login(guestShare.email);
      assert(relog?.user, "重新登录应返回用户");
      const accountUser = (await guestShare.api.get("/api/auth/me")).json.user;
      const accountBoard = await guestShare.api.createBoard({ title: "账号板" });
      assert(accountBoard.status === 201, `账号建板 ${accountBoard.status}`);
      const accountBoardId = accountBoard.json.id;

      await setSessionCookie(guestPage, guestShare.api.sessionCookie);
      await guestPage.reload({ waitUntil: "networkidle2" });
      await guestPage.waitForSelector('[data-testid="boards-user"]', { timeout: 20_000 });
      await until(async () => (await boardIds(guestPage)).includes(accountBoardId), { label: "账号板出现" });
      const userIds = await boardIds(guestPage);
      assert(!userIds.includes(guestBoardId), "账号视图不应出现游客板");

      const info = await thumbStoreInfo(guestPage);
      eq(info.keyPath, ["owner", "boardId"], "thumbs 主键应为 [owner, boardId]");
      assert(
        info.owners.every((owner) => owner === "guest" || owner.startsWith("user:")),
        `thumbs 的 owner 取值：${info.owners.join(",")}`,
      );
      assert(
        info.owners.filter((owner) => owner.startsWith(`user:${accountUser.id}`)).length <= 1,
        "当前账号最多一份缩略图记录",
      );

      const home4 = await openHome(guestContext, true);
      await logoutFromHome(home4);
      await until(async () => (await boardIds(guestPage)).includes(guestBoardId), { label: "游客板再次出现" });
      eq(await boardIds(guestPage), [guestBoardId], "第二轮退出仍只显示游客板");
      assert(!(await boardIds(guestPage)).includes(accountBoardId), "账号板不得残留");
      await home4.close();
    });

    // ---------- 场景 C：受限页 /boards/trash 在退出后被守卫弹回登录页 ----------
    const trashUser = await registerUser("logout-trash");
    const { context: trashContext, page: trashPage } = await newPage(browser, {
      cookie: trashUser.api.sessionCookie,
      width: 1440,
      height: 950,
    });
    await trashPage.goto(`${WEB}/boards/trash`, { waitUntil: "networkidle2" });
    await trashPage.waitForSelector('[data-testid="trash-user"]', { timeout: 20_000 });

    await test("回收站标签页收到退出广播：跳到 /login?returnTo=/boards/trash", async () => {
      const home5 = await openHome(trashContext, true);
      await logoutFromHome(home5);
      await until(() => trashPage.url().includes("/login"), { label: "回收站被守卫弹走" });
      const url = new URL(trashPage.url());
      eq(url.pathname, "/login", "应落到登录页");
      eq(url.searchParams.get("returnTo"), "/boards/trash", "带 returnTo");
      await trashPage.waitForSelector('[data-testid="auth-card"]', { timeout: 20_000 });
      assert(await trashPage.$('[data-testid="auth-card"]'), "登录表单应可见");
      await home5.close();
    });

    // ---------- 场景 D：列表页顶栏自带的退出入口（键盘可达，单标签也生效） ----------
    const inlineUser = await registerUser("logout-inline");
    for (let i = 0; i < 2; i += 1) await inlineUser.api.createBoard({ title: `I-${i + 1}` });
    const { page: inlinePage } = await newPage(browser, {
      cookie: inlineUser.api.sessionCookie,
      width: 1440,
      height: 950,
    });
    await openBoards(inlinePage);
    await inlinePage.waitForSelector('[data-testid="boards-user"]', { timeout: 20_000 });

    await test("顶栏退出登录：Enter 触发，立即切游客且不留旧列表", async () => {
      await watchFrames(inlinePage);
      await inlinePage.focus('[data-testid="boards-logout"]');
      await inlinePage.keyboard.press("Enter");
      await inlinePage.waitForSelector('[data-testid="boards-login"]', { timeout: 15_000 });
      await inlinePage.waitForSelector('[data-testid="boards-empty"]', { timeout: 15_000 });
      const frames = await readFrames(inlinePage);
      const flip = frames.findIndex((frame) => frame.user === null);
      assert(flip >= 0, "应记录到退出后的帧");
      const after = frames.slice(flip);
      assert(after.every((frame) => frame.user === null), "退出后不应再出现用户名");
      assert(after.every((frame) => frame.space === false), "退出后不应再有空间胶囊");
      assert(after.every((frame) => frame.trash === false), "退出后不应再有回收站入口");
      eq(after.flatMap((frame) => frame.cards), [], "退出后任何一帧都不应有账号的板");
      const me = await inlinePage.evaluate(() => fetch("/api/auth/me").then((res) => res.status));
      eq(me, 401, "顶栏退出后 /api/auth/me");
      eq(await inlinePage.$('[data-testid="boards-logout"]'), null, "游客不应显示退出入口");
      const count = await inlinePage.$eval(".wb-boards__count", (node) =>
        node.textContent.replace(/\s+/g, " ").trim(),
      );
      eq(count, "0 / 12", "容量计数");
    });

    await test("空态登录入口：进入登录页并带回跳参数", async () => {
      await inlinePage.click('[data-testid="boards-empty-login"]');
      await inlinePage.waitForFunction(() => location.pathname === "/login", { timeout: 15_000 });
      const url = new URL(inlinePage.url());
      eq(url.searchParams.get("next"), "/boards", "登录后回跳 /boards");
    });

    // ---------- 场景 D2：双标签 —— A 停在列表页，B 退出后 A 原地切游客（不刷新） ----------
    const duo = await registerUser("logout-duo");
    await duo.api.createBoard({ title: "双标签A" });
    const duoPair = await newPage(browser, { cookie: duo.api.sessionCookie, width: 1440, height: 950 });
    const pageA = duoPair.page;
    await openBoards(pageA);
    await pageA.waitForSelector('[data-testid="boards-logout"]', { timeout: 20_000 });

    await test("双标签：A 停在列表页，B 退出后 A 自动切游客", async () => {
      const pageB = await duoPair.context.newPage();
      await pageB.setViewport({ width: 1440, height: 950, deviceScaleFactor: 1 });
      await pageB.goto(`${WEB}/boards`, { waitUntil: "networkidle2" });
      await pageB.waitForSelector('[data-testid="boards-logout"]', { timeout: 20_000 });
      await pageB.click('[data-testid="boards-logout"]');

      // A 没有任何导航，只靠 BroadcastChannel 广播切换
      await pageA.waitForSelector('[data-testid="boards-login"]', { timeout: 15_000 });
      eq(new URL(pageA.url()).pathname, "/boards", "A 仍停在列表页，未跳转");
      eq(await pageA.$$eval('[data-testid="board-card"]', (nodes) => nodes.length), 0, "A 不应再显示账号的板");
      eq(await pageA.$('[data-testid="boards-logout"]'), null, "A 不应再有退出入口");
      eq(await pageA.$('[data-testid="space-switcher"]'), null, "A 不应再有空间胶囊");
      eq(await pageA.evaluate(() => fetch("/api/auth/me").then((res) => res.status)), 401, "A 的会话已失效");
      await pageB.close();
    });

    // ---------- 场景 E：老版本残留（旧全局 key + v2 无归属缩略图）在新版本首启被清掉 ----------
    // IndexedDB 按源共享：只要还有页面连着 wb-cache，deleteDatabase 就会一直 blocked，
    // 后面的 open(v2) 永远排队。先把前面用过的页面全关掉，再重建老版本库。
    await boardsPage.close();
    await home.close();
    await guestPage.close();
    await trashPage.close();
    await inlinePage.close();
    await pageA.close();

    // 单独起一个干净 profile 的浏览器，并先停一个**不加载应用**的同源文档上：
    // main.tsx 启动就会 purgeExpiredCache() 打开 wb-cache，只要页面持有连接，
    // deleteDatabase 就会一直 blocked，紧接着的 open(v2) 永远排队。
    const legacyBrowser = await launchBrowser();
    const { page: legacyPage } = await newPage(legacyBrowser, { width: 1200, height: 800 });
    await legacyPage.goto(`${WEB}/api/health`, { waitUntil: "domcontentloaded" });
    await legacyPage.evaluate(async () => {
      await new Promise((resolve, reject) => {
        const del = indexedDB.deleteDatabase("wb-cache");
        del.onsuccess = () => resolve();
        del.onerror = () => reject(del.error);
        del.onblocked = () => resolve();
      });
      // 还原 v2 结构：thumbs 主键只有 boardId，且已有一条上一个身份留下的记录
      await new Promise((resolve, reject) => {
        const req = indexedDB.open("wb-cache", 2);
        req.onupgradeneeded = () => {
          const db = req.result;
          db.createObjectStore("elements", { keyPath: ["boardId", "elementId"] });
          db.createObjectStore("outbox", { autoIncrement: true });
          db.createObjectStore("meta", { keyPath: "boardId" });
          db.createObjectStore("thumbs", { keyPath: "boardId" });
        };
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("thumbs", "readwrite");
          tx.objectStore("thumbs").put({
            boardId: "legacy-board",
            blob: new Blob(["legacy"], { type: "image/webp" }),
            signature: "legacy",
            updatedAt: Date.now(),
          });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      });
      localStorage.setItem(
        "wb:recentBoards",
        JSON.stringify([
          {
            id: "legacy-board",
            title: "旧账号遗留",
            lastEditedAt: new Date().toISOString(),
            openedCount: 3,
            pinned: false,
          },
        ]),
      );
    });

    await test("升级首启：旧全局 key 丢弃、v2 缩略图清空重建，列表可继续使用", async () => {
      await openBoards(legacyPage);
      await legacyPage.waitForSelector('[data-testid="boards-empty"]', { timeout: 20_000 });
      const keys = await storageKeys(legacyPage);
      assert(!keys.includes(LEGACY_KEY), `旧全局 key 应被丢弃：${keys.join(",")}`);
      eq(await boardIds(legacyPage), [], "旧记录不应被当成游客临时板");
      const info = await thumbStoreInfo(legacyPage);
      eq(info.keyPath, ["owner", "boardId"], "thumbs 升级后主键");
      eq(info.owners, [], "旧的 v2 缩略图应清空");

      // 清空后的缓存链路仍可用：新建一块会重新写入游客记录，缩略图按需重拍
      await legacyPage.click('[data-testid="boards-new"]');
      await legacyPage.waitForFunction(() => location.pathname.startsWith("/board/"), { timeout: 20_000 });
      await drawRectangle(legacyPage);
      await openBoards(legacyPage);
      const ids = await boardIds(legacyPage);
      eq(ids.length, 1, "新建后游客列表");
      await until(async () => (await thumbStoreInfo(legacyPage)).owners.includes("guest"), {
        label: "升级后重拍游客缩略图",
        timeout: 20_000,
      });
    });

    await legacyBrowser.close();
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
