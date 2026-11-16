import crypto from "node:crypto";
import { Api, registerUser } from "../lib/api.mjs";
import { WEB } from "../lib/config.mjs";
import { assert, eq, finish, screenshotPath, sleep, test, until } from "../lib/harness.mjs";
import { boardIds, launchBrowser, newPage } from "../lib/browser.mjs";
import { closePool, query } from "../lib/db.mjs";

/**
 * 游客临时板转入账号（上限只针对游客，登录账号不限量）：
 * - 3 + 5 → 全转入，列表 8 块，缩略图与本机「最近打开」一起搬家，刷新保持；
 * - 5 + 10 → 全部转入 15 块（超过 12 也能进），不再有「容量不足 / 去整理 / 暂不」分支；
 * - 12 + 0 → 12 块全部转入，重复提交返回 transferred:0；
 * - 两个标签同时提交，最终 12 块且不重复；
 * - 游客 cookie 缺失/失效 → 409 GUEST_COOKIE_INVALID；请求里夹带别人的 boardIds 无效。
 */

const spec = "claim";

const GUEST_KEY = "wb:recentBoards:guest";
const DISMISSED_KEY = "wb:boardsClaimDismissed";

function seedId() {
  return crypto.randomBytes(9).toString("base64url").slice(0, 12);
}

async function seedGuestBoards(guestId, count, tag) {
  const ids = [];
  for (let i = 0; i < count; i += 1) {
    const id = seedId();
    await query("insert into boards (id, title, owner_id, owner_guest_id) values ($1, $2, null, $3)", [
      id,
      `${tag}${i + 1}`,
      guestId,
    ]);
    ids.push(id);
  }
  return ids;
}

async function guestIdOf(boardId) {
  const { rows } = await query("select owner_guest_id from boards where id = $1", [boardId]);
  return rows[0]?.owner_guest_id ?? null;
}

async function boardRow(boardId) {
  const { rows } = await query("select owner_id, owner_guest_id, space_id from boards where id = $1", [boardId]);
  return rows[0] ?? null;
}

async function countBoards(column, value) {
  const { rows } = await query(
    `select count(*)::int as n from boards where ${column} = $1 and deleted_at is null and archived_at is null`,
    [value],
  );
  return rows[0].n;
}

function readThumb(page, owner, boardId) {
  return page.evaluate(
    ({ owner, id }) =>
      new Promise((resolve) => {
        const request = indexedDB.open("wb-cache");
        request.onerror = () => resolve(null);
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("thumbs")) {
            resolve(null);
            return;
          }
          const tx = db.transaction("thumbs", "readonly");
          const get = tx.objectStore("thumbs").get([owner, id]);
          get.onerror = () => resolve(null);
          get.onsuccess = () => {
            const value = get.result;
            resolve(value ? { signature: value.signature, size: value.blob?.size ?? 0 } : null);
          };
        };
      }),
    { owner, id: boardId },
  );
}

async function thumbKeys(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const request = indexedDB.open("wb-cache");
        request.onerror = () => resolve([]);
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("thumbs")) {
            resolve([]);
            return;
          }
          const tx = db.transaction("thumbs", "readonly");
          const keys = tx.objectStore("thumbs").getAllKeys();
          keys.onerror = () => resolve([]);
          keys.onsuccess = () => resolve(keys.result ?? []);
        };
      }),
  );
}

async function readRecents(page) {
  return page.evaluate(() => {
    const parse = (key) => {
      try {
        return JSON.parse(localStorage.getItem(key) ?? "[]");
      } catch {
        return [];
      }
    };
    return {
      guest: parse("wb:recentBoards:guest"),
      users: Object.fromEntries(
        Object.keys(localStorage)
          .filter((key) => key.startsWith("wb:recentBoards:user:"))
          .sort()
          .map((key) => [key, parse(key)]),
      ),
    };
  });
}

async function drawRectangle(page) {
  const canvas = await page.$(".excalidraw__canvas.interactive");
  assert(canvas, "找不到 Excalidraw 交互画布");
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
  await sleep(900);
}

async function openBoardsPage(page) {
  await page.goto(`${WEB}/boards`, { waitUntil: "networkidle2" });
  await page.waitForSelector('[data-testid="boards-new"]', { timeout: 25_000 });
  await sleep(400);
}

/** 游客身份下新建一块板（可画一笔留下缩略图），返回列表后拿到它的 id */
async function createGuestBoard(page, { draw = false } = {}) {
  await page.click('[data-testid="boards-new"]');
  await page.waitForSelector(".excalidraw__canvas.interactive", { timeout: 25_000 });
  await sleep(900);
  if (draw) await drawRectangle(page);
  await page.click('[data-testid="board-back"]');
  await page.waitForSelector('[data-testid="board-card"], [data-testid="boards-empty"]', { timeout: 25_000 });
  await sleep(600);
  const ids = await boardIds(page);
  assert(ids.length > 0, "新建后列表应有卡片");
  return ids[0];
}

async function registerViaUi(page, email, displayName = "认领测试") {
  await page.goto(`${WEB}/login?next=%2Fboards`, { waitUntil: "networkidle2" });
  await page.waitForSelector('[data-testid="auth-card"]', { timeout: 25_000 });
  await page.click(".wb-auth__switch");
  await page.waitForSelector('[data-testid="auth-display-name"]', { timeout: 8_000 });
  await page.type('[data-testid="auth-display-name"]', displayName);
  await page.type('[data-testid="auth-email"]', email);
  await page.type('[data-testid="auth-password"]', "Whiteboard#2026");
  await page.click('[data-testid="auth-submit"]');
  await page.waitForSelector('[data-testid="claim-dialog"]', { timeout: 25_000 });
}

async function createBoardsThroughApi(page, count, prefix = "账号板") {
  const statuses = await page.evaluate(
    async ({ count, prefix }) => {
      const out = [];
      for (let i = 0; i < count; i += 1) {
        const res = await fetch("/api/boards", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: `${prefix}${i + 1}` }),
        });
        out.push(res.status);
      }
      return out;
    },
    { count, prefix },
  );
  assert(
    statuses.every((status) => status < 300),
    `账号建板失败：${statuses.join(",")}`,
  );
}

async function currentUser(page) {
  return page.evaluate(async () => {
    const res = await fetch("/api/auth/me");
    return res.ok ? (await res.json()).user : null;
  });
}

async function clearDismissed(page) {
  await page.evaluate((key) => localStorage.removeItem(key), DISMISSED_KEY);
}

async function waitCards(page, count, label) {
  await until(async () => (await boardIds(page)).length === count, { label, timeout: 25_000 });
}

/** 超过 11 块时点掉「更多」占位格，直到全部卡片可见（同时等待异步刷新落定） */
async function revealAll(page, count, label) {
  await until(
    async () => {
      if ((await boardIds(page)).length === count) return true;
      const more = await page.$('[data-testid="boards-more"]');
      if (!more) return false;
      await more.click();
      await sleep(200);
      return false;
    },
    { label, timeout: 25_000 },
  );
}

async function openClaimDialogFromBanner(page) {
  await page.waitForSelector('[data-testid="claim-banner"]', { timeout: 20_000 });
  await page.click('[data-testid="claim-banner-open"]');
  await page.waitForSelector('[data-testid="claim-dialog"]', { timeout: 10_000 });
}

async function main() {
  const browser = await launchBrowser();
  try {
    // ---------------------------------------------------------------
    // A. 游客 3 + 账号 5 → 全部转入；缩略图 / 本机记录一起搬家
    // ---------------------------------------------------------------
    await test("游客 3 + 账号 5：全部转入 8 块，缩略图与本机记录搬家", async () => {
      const { page, context } = await newPage(browser, { width: 1440, height: 950 });
      await openBoardsPage(page);
      const withThumb = await createGuestBoard(page, { draw: true });
      await createGuestBoard(page);
      await createGuestBoard(page);
      const guestId = await guestIdOf(withThumb);
      assert(guestId, "游客板应有 owner_guest_id");
      await registerViaUi(page, `claim.a.${Date.now()}@example.com`);

      // 弹窗内容：3 块、说明「暂不」的后果
      const dialogText = await page.$eval('[data-testid="claim-dialog"]', (node) => node.textContent ?? "");
      assert(dialogText.includes("3"), `弹窗应显示 3 块：${dialogText}`);
      assert(dialogText.includes("退出登录"), "弹窗应说明暂不后退出登录才回来");
      await page.click('[data-testid="claim-later"]');
      await page.waitForSelector('[data-testid="boards-empty"]', { timeout: 25_000 });
      eq(await boardIds(page), [], "暂不后登录态看不到游客板");

      await createBoardsThroughApi(page, 5, "A账号");
      await clearDismissed(page);
      await page.reload({ waitUntil: "networkidle2" });
      await waitCards(page, 5, "账号 5 块");
      await openClaimDialogFromBanner(page);

      const policy = await page.$eval('[data-testid="claim-policy"]', (node) => node.textContent ?? "");
      assert(policy.includes("不限"), `弹窗应说明账号不限数量：${policy}`);
      await page.click('[data-testid="claim-submit"]');
      await page.waitForFunction(
        () => (document.querySelector(".wb-toast")?.textContent ?? "").includes("已转入 3 块"),
        { timeout: 25_000 },
      );
      await waitCards(page, 8, "转入后 8 块");

      const me = await currentUser(page);
      assert(me, "应能读到当前用户");
      const owner = `user:${me.id}`;
      const movedRow = await boardRow(withThumb);
      eq(
        { ownerId: movedRow.owner_id, guest: movedRow.owner_guest_id, hasSpace: Boolean(movedRow.space_id) },
        { ownerId: me.id, guest: null, hasSpace: true },
        "转入后归属与空间",
      );

      // 缩略图：guest 键消失、user 键出现且能读到 640×400 的图
      const thumb = await until(() => readThumb(page, owner, withThumb), { label: "账号侧缩略图", timeout: 15_000 });
      assert(thumb.size > 1000, `缩略图体积 ${thumb.size}`);
      const keys = await thumbKeys(page);
      assert(
        !keys.some((key) => Array.isArray(key) && key[0] === "guest" && key[1] === withThumb),
        "guest 键应被搬走",
      );

      // 本机最近打开：游客那份清掉，账号那份含这块板
      await sleep(500);
      const recents = await readRecents(page);
      assert(!recents.guest.some((item) => item.id === withThumb), "游客 recentBoards 不应再含已转板");
      const userRecents = recents.users[`wb:recentBoards:${owner}`] ?? [];
      assert(userRecents.some((item) => item.id === withThumb), "账号 recentBoards 应含已转板");

      // 刷新保持
      await page.reload({ waitUntil: "networkidle2" });
      await waitCards(page, 8, "刷新后 8 块");
      const src = await page.$eval(`[data-board-id="${withThumb}"] img`, (img) => img.getAttribute("src"));
      assert(src?.startsWith("blob:"), `刷新后卡片应有缩略图：${src}`);
      await page.screenshot({ path: screenshotPath("claim-after-transfer") });

      // 重复提交不翻倍：协议层再打两次
      const repeat = await page.evaluate(async () => {
        const out = [];
        for (let i = 0; i < 2; i += 1) {
          const res = await fetch("/api/guest/claim", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
          out.push({ status: res.status, body: await res.json() });
        }
        return out;
      });
      eq(
        repeat.map((item) => item.body.transferred),
        [0, 0],
        "重复提交应 transferred:0",
      );
      await waitCards(page, 8, "重复提交后仍 8 块");
      await context.close();
    });

    // ---------------------------------------------------------------
    // B. 游客 5 + 账号 10 → 无条件全部转入 15 块；390 夜间弹窗不溢出
    // ---------------------------------------------------------------
    await test("游客 5 + 账号 10：全部转入 15 块，无容量拒绝分支；390 夜间弹窗不溢出", async () => {
      const { page, context } = await newPage(browser, { width: 1440, height: 950 });
      await openBoardsPage(page);
      const first = await createGuestBoard(page);
      const guestId = await guestIdOf(first);
      const seeded = await seedGuestBoards(guestId, 4, "B种子");
      assert(seeded.length === 4, "种子板 4 块");
      await registerViaUi(page, `claim.b.${Date.now()}@example.com`, "超十二块");
      await page.click('[data-testid="claim-later"]');
      await page.waitForSelector('[data-testid="boards-empty"]', { timeout: 25_000 });
      await createBoardsThroughApi(page, 10, "B账号");
      await clearDismissed(page);
      await page.reload({ waitUntil: "networkidle2" });
      await waitCards(page, 10, "账号 10 块");
      await openClaimDialogFromBanner(page);
      const policy = await page.$eval('[data-testid="claim-policy"]', (node) => node.textContent ?? "");
      assert(policy.includes("不限"), `弹窗应说明账号不限数量：${policy}`);
      eq(await page.$('[data-testid="claim-organize"]'), null, "不应再出现「去整理」入口");

      // 390 × 夜间：弹窗不横向溢出（提交前）
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
      await page.evaluate(() => {
        document.documentElement.dataset.theme = "night";
      });
      await sleep(400);
      const metrics = await page.evaluate(() => {
        const dialog = document.querySelector('[data-testid="claim-dialog"] .wb-dialog');
        const rect = dialog?.getBoundingClientRect();
        const btn = document.querySelector('[data-testid="claim-submit"]');
        return {
          width: Math.round(rect?.width ?? 0),
          left: Math.round(rect?.left ?? 0),
          innerWidth: window.innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          theme: document.documentElement.dataset.theme,
          buttonWidth: Math.round(btn?.getBoundingClientRect().width ?? 0),
          buttonHeight: Math.round(btn?.getBoundingClientRect().height ?? 0),
        };
      });
      assert(metrics.width > 0 && metrics.width <= metrics.innerWidth, `弹窗宽 ${metrics.width} 超出 ${metrics.innerWidth}`);
      assert(metrics.left >= 0, `弹窗左边距 ${metrics.left}`);
      assert(metrics.scrollWidth <= metrics.innerWidth, `横向溢出：${metrics.scrollWidth} > ${metrics.innerWidth}`);
      assert(metrics.buttonHeight > 30 && metrics.buttonHeight <= 44, `「全部转入」按钮高度异常：${metrics.buttonHeight}px`);
      eq(metrics.theme, "night", "应处于夜间主题");
      await page.screenshot({ path: screenshotPath("claim-390-night") });

      await page.setViewport({ width: 1440, height: 950, deviceScaleFactor: 1 });
      await page.evaluate(() => {
        delete document.documentElement.dataset.theme;
      });
      await sleep(300);
      await page.click('[data-testid="claim-submit"]');
      await revealAll(page, 15, "转入后 15 块");
      eq(await countBoards("owner_guest_id", guestId), 0, "游客板应全部转入，一块不剩");

      const me = await currentUser(page);
      eq(await countBoards("owner_id", me.id), 15, "账号侧 15 块全部到位");
      const placed = await Promise.all(seeded.map((id) => boardRow(id)));
      eq(
        placed.every((row) => row && row.owner_id === me.id && row.owner_guest_id === null && row.space_id),
        true,
        "转入后归属与个人空间都写入",
      );
      await page.screenshot({ path: screenshotPath("claim-transfer-over-12") });
      await context.close();
    });

    // ---------------------------------------------------------------
    // C. 游客 12 + 账号 0 → 刚好 12；重复提交不翻倍
    // ---------------------------------------------------------------
    await test("游客 12 + 账号 0：刚好转入 12 块，重复提交不翻倍", async () => {
      const { page, context } = await newPage(browser, { width: 1440, height: 950 });
      await openBoardsPage(page);
      const first = await createGuestBoard(page);
      const guestId = await guestIdOf(first);
      await seedGuestBoards(guestId, 11, "C种子");
      await registerViaUi(page, `claim.c.${Date.now()}@example.com`, "十二块");
      const title = await page.$eval('[data-testid="claim-dialog"]', (node) => node.textContent ?? "");
      assert(title.includes("12"), `弹窗应显示 12 块：${title}`);
      await page.click('[data-testid="claim-submit"]');
      await page.waitForSelector('[data-testid="boards-grid"]', { timeout: 25_000 });
      await revealAll(page, 12, "转入后 12 块");
      eq(await countBoards("owner_guest_id", guestId), 0, "游客板应清空");
      const me = await currentUser(page);
      eq(await countBoards("owner_id", me.id), 12, "账号侧 12 块");

      const repeat = await page.evaluate(async () => {
        const res = await fetch("/api/guest/claim", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        return { status: res.status, body: await res.json() };
      });
      eq(repeat.status, 200, "重复提交仍返回 200");
      eq(repeat.body.transferred, 0, "重复提交不翻倍");
      await page.reload({ waitUntil: "networkidle2" });
      await revealAll(page, 12, "刷新后仍 12 块");
      await context.close();
    });

    // ---------------------------------------------------------------
    // D. 两个标签同时提交
    // ---------------------------------------------------------------
    await test("两个标签同时点「全部转入」：最终 12 块且不重复", async () => {
      const { page, context } = await newPage(browser, { width: 1440, height: 950 });
      await openBoardsPage(page);
      const first = await createGuestBoard(page);
      const guestId = await guestIdOf(first);
      await seedGuestBoards(guestId, 2, "D种子");
      await registerViaUi(page, `claim.d.${Date.now()}@example.com`, "双标签");
      await page.click('[data-testid="claim-later"]');
      await page.waitForSelector('[data-testid="boards-empty"]', { timeout: 25_000 });
      await createBoardsThroughApi(page, 9, "D账号");
      await clearDismissed(page);
      await page.reload({ waitUntil: "networkidle2" });
      await waitCards(page, 9, "账号 9 块");

      const second = await context.newPage();
      await second.setViewport({ width: 1440, height: 950, deviceScaleFactor: 1 });
      await second.goto(`${WEB}/boards`, { waitUntil: "networkidle2" });
      await second.waitForSelector('[data-testid="claim-banner"]', { timeout: 25_000 });

      await page.bringToFront();
      await openClaimDialogFromBanner(page);
      await second.bringToFront();
      await second.click('[data-testid="claim-banner-open"]');
      await second.waitForSelector('[data-testid="claim-dialog"]', { timeout: 10_000 });
      // 后台标签页里 rAF 被节流，Puppeteer 的 mouse click 会一直等"位置稳定"而卡死；
      // 两边都用 DOM click 触发同一个提交处理器，保证请求落在同一轮事件里。
      await Promise.all([
        page.evaluate(() => document.querySelector('[data-testid="claim-submit"]')?.click()),
        second.evaluate(() => document.querySelector('[data-testid="claim-submit"]')?.click()),
      ]);

      // 后台标签页在 headless 下会被节流，后续 reload / evaluate 可能挂到 protocolTimeout；
      // 并发提交已经完成，关掉第二页再收尾，避免整段卡死。
      await page.bringToFront();
      await second.close();

      const me = await currentUser(page);
      await until(async () => (await countBoards("owner_id", me.id)) === 12, { label: "最终 12 块", timeout: 25_000 });
      eq(await countBoards("owner_guest_id", guestId), 0, "游客板应清空");
      await page.reload({ waitUntil: "networkidle2" });
      await revealAll(page, 12, "双标签最终 12 块");
      const ids = await boardIds(page);
      eq(new Set(ids).size, ids.length, "不应出现重复卡片");
      await page.bringToFront();
      await page.screenshot({ path: screenshotPath("claim-two-tabs") });
      await context.close();
    });

    // ---------------------------------------------------------------
    // E. 游客 cookie 缺失/失效；夹带别人的 boardIds 无效
    // ---------------------------------------------------------------
    await test("游客 cookie 失效报 GUEST_COOKIE_INVALID，夹带他人 id 无效", async () => {
      const lonely = await registerUser("claim.nocookie");
      const preview = await lonely.api.get("/api/guest/claim-preview");
      eq(preview.status, 200, "preview 仍可读");
      eq(preview.json.guestActive, false, "无游客 cookie 时 guestActive=false");
      eq(preview.json.count, 0, "无游客 cookie 时 count=0");
      const invalid = await lonely.api.post("/api/guest/claim");
      eq(invalid.status, 409, "无游客 cookie 的 claim 应 409");
      eq(invalid.json.error.code, "GUEST_COOKIE_INVALID", "错误码");
      assert(invalid.json.error.message.includes("游客身份已失效"), `文案：${invalid.json.error.message}`);

      // 另一个游客名下的板：登录态夹带 boardIds 也不能转
      const stranger = new Api("claim.stranger");
      const created = await stranger.post("/api/boards", { title: "别人的临时板" });
      const strangerBoard = created.json.id;
      await lonely.api.post("/api/guest/claim", { boardIds: [strangerBoard] });
      const strangerRow = await boardRow(strangerBoard);
      eq(strangerRow.owner_id, null, "他人游客板仍无 owner_id");
      eq(await countBoards("owner_guest_id", strangerRow.owner_guest_id), 1, "他人的游客板不应被转走");
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
