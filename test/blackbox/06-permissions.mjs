import { Api, registerGuest, registerUser } from "../lib/api.mjs";
import { assert, eq, finish, test } from "../lib/harness.mjs";
import { launchBrowser, newPage } from "../lib/browser.mjs";
import { closePool, disableUser, insertExpiredShare, userIdByEmail } from "../lib/db.mjs";
import { PASSWORD, WEB } from "../lib/config.mjs";

const spec = "permissions";

async function main() {
  await test("游客只能删自己的板", async () => {
    const a = await registerGuest();
    const b = await registerGuest();
    const own = await b.api.createBoard({ title: "B 的板" });
    eq(own.status, 201, "B 建板");

    const foreign = await b.api.removeBoard(a.firstBoard.id);
    eq(foreign.status, 404, "删除他人板应 404");
    const stillThere = await a.api.list();
    eq(stillThere.status, 401, "游客没有列表接口");
    const ops = await a.api.get(`/api/boards/${a.firstBoard.id}/snapshot`);
    eq(ops.status, 200, "A 的板仍在（快照可读）");

    const removed = await b.api.removeBoard(own.json.id);
    eq(removed.status, 200, "删除自己的板");
    eq(removed.json?.mode, "purged", "游客删除是物理删除");
    const gone = await b.api.get(`/api/boards/${own.json.id}/snapshot`);
    eq(gone.status, 404, "删后不可访问");
  });

  await test("未登录访问受限页：/boards 开放，/boards/trash 跳登录并登录后回跳", async () => {
    const browser = await launchBrowser();
    try {
      // /boards 对游客开放，展示本机最近打开；不跳登录
      const guest = await newPage(browser, { width: 1280, height: 900 });
      await guest.page.goto(`${WEB}/boards`, { waitUntil: "networkidle2" });
      await guest.page.waitForSelector(".wb-page--boards", { timeout: 20_000 });
      eq(new URL(guest.page.url()).pathname, "/boards", "/boards 不应跳走");
      const hasGuestUi = await guest.page.evaluate(
        () => Boolean(document.querySelector('[data-testid="boards-empty"]')) || document.querySelectorAll('[data-testid="board-card"]').length > 0,
      );
      eq(hasGuestUi, true, "游客态应能看到空态或本机最近打开");

      // 回收站是受限页：游客访问 → 跳 /login?returnTo=<当前路径>，且不闪游客面板
      await guest.page.goto(`${WEB}/boards/trash`, { waitUntil: "networkidle2" });
      await guest.page.waitForSelector('[data-testid="auth-card"]', { timeout: 20_000 });
      const landed = new URL(guest.page.url());
      eq(landed.pathname, "/login", "受限页应跳到登录页");
      eq(landed.searchParams.get("returnTo"), "/boards/trash", "returnTo 应带当前路径");
      const flashed = await guest.page.evaluate(() => (document.body.textContent ?? "").includes("登录后才能使用回收站"));
      eq(flashed, false, "跳转前不应先闪游客提示面板");
      await guest.context.close();

      // 登录成功后按 returnTo 回跳回收站（真实表单登录）
      const { email } = await registerUser("trash-login");
      const logged = await newPage(browser, { width: 1280, height: 900 });
      await logged.page.goto(`${WEB}/login?returnTo=%2Fboards%2Ftrash`, { waitUntil: "networkidle2" });
      await logged.page.waitForSelector('[data-testid="auth-card"]', { timeout: 20_000 });
      await logged.page.type('[data-testid="auth-email"]', email);
      await logged.page.type('[data-testid="auth-password"]', PASSWORD);
      await Promise.all([
        logged.page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30_000 }),
        logged.page.click('[data-testid="auth-submit"]'),
      ]);
      await logged.page.waitForSelector(".wb-page--trash", { timeout: 20_000 });
      eq(new URL(logged.page.url()).pathname, "/boards/trash", "登录后应回跳回收站");
      const trashState = await logged.page.evaluate(() => ({
        guestPanel: (document.body.textContent ?? "").includes("登录后才能使用回收站"),
        user: document.querySelector('[data-testid="trash-user"]')?.textContent ?? null,
      }));
      eq(trashState.guestPanel, false, "登录后不应再看到游客提示面板");
      assert(trashState.user, "登录后回收站应显示用户名");
      await logged.context.close();
    } finally {
      await browser.close();
    }
  });

  await test("returnTo 白名单：站外地址被丢弃，登录后回默认页", async () => {
    const { email } = await registerUser("return-to");
    const browser = await launchBrowser();
    try {
      const { page, context } = await newPage(browser, { width: 1280, height: 900 });
      await page.goto(`${WEB}/login?returnTo=${encodeURIComponent("https://evil.example/phish")}`, {
        waitUntil: "networkidle2",
      });
      await page.waitForSelector('[data-testid="auth-card"]', { timeout: 20_000 });
      await page.type('[data-testid="auth-email"]', email);
      await page.type('[data-testid="auth-password"]', PASSWORD);
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30_000 }),
        page.click('[data-testid="auth-submit"]'),
      ]);
      eq(new URL(page.url()).pathname, "/", "站外 returnTo 应被丢弃，登录后回默认页");
      await context.close();
    } finally {
      await browser.close();
    }
  });

  await test("分享 token：有效可读、撤销即失效、过期即失效", async () => {
    const { api } = await registerUser("share");
    const board = await api.createBoard({ title: "分享板" });
    const first = await api.createShare(board.json.id, "read", 7);
    eq(first.status, 201, `建分享：${JSON.stringify(first.json)}`);
    const token = first.json.token;
    assert(token, "应返回明文 token");

    const reader = new Api("reader");
    const viaShare = await reader.request("GET", `/api/boards/${board.json.id}/snapshot`, {
      headers: { "x-share-token": token },
    });
    eq(viaShare.status, 200, "有效 token 可读");

    const wrong = await reader.request("GET", `/api/boards/${board.json.id}/snapshot`, {
      headers: { "x-share-token": "not-a-real-token" },
    });
    eq(wrong.status, 404, "错误 token 应 404");

    await api.revokeShare(board.json.id, first.json.id);
    const revoked = await reader.request("GET", `/api/boards/${board.json.id}/snapshot`, {
      headers: { "x-share-token": token },
    });
    eq(revoked.status, 404, "撤销后应 404");

    // 过期：直接落一条 expires_at 已过的记录（接口创建会先写 60s 缓存，绕开它才测得到过期分支）
    const expiredToken = `s_${Math.random().toString(36).slice(2)}${"B".repeat(30)}`.slice(0, 45);
    await insertExpiredShare(board.json.id, expiredToken);
    const expired = await reader.request("GET", `/api/boards/${board.json.id}/snapshot`, {
      headers: { "x-share-token": expiredToken },
    });
    eq(expired.status, 404, "过期后应 404");
  });

  await test("软删用户后会话与登录都失效", async () => {
    const { api, email } = await registerUser("disabled");
    eq((await api.get("/api/auth/me")).status, 200, "软删前 me");
    await disableUser(await userIdByEmail(email));
    eq((await api.get("/api/auth/me")).status, 401, "软删后 me 应 401");
    const fresh = new Api("disabled-login");
    const login = await fresh.post("/api/auth/login", {
      email,
      password: "Xk7#mQ2vLp9wZ",
    });
    assert([401, 403].includes(login.status), `软删用户登录应被拒：${login.status}`);
  });

  await closePool();
  finish(spec);
}

main().catch(async (error) => {
  console.error(error);
  await closePool().catch(() => {});
  process.exitCode = 1;
});
