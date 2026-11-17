#!/usr/bin/env node
/**
 * 13 · 鉴权与账号
 *
 * 覆盖：
 * - 安全响应头（全环境基础头；生产 CSP/HSTS 由 curl 侧验证，开发不设 CSP）；
 * - 账号设置弹窗：顶栏胶囊入口、显示名修改（界面与接口同步）；
 * - 登录态改密：其它会话立即失效、旧密码不能登录、当前标签页不掉线；
 * - 销号：当前密码二次确认 → 回首页 → 用户行停用 + 昵称/占位邮箱、业务数据物理删除、原邮箱可重新注册；
 * - 团队空间所有者拦截：还有成员时 409，解散后可注销。
 */
import { openBoards, launchBrowser, newPage } from "../lib/browser.mjs";
import { Api, registerUser } from "../lib/api.mjs";
import { API, PASSWORD, WEB } from "../lib/config.mjs";
import { query } from "../lib/db.mjs";
import { assert, eq, finish, test, until } from "../lib/harness.mjs";

const NEW_PASSWORD = "Nq8$Rz3wKp6vT#";

const browser = await launchBrowser();

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

try {
  const { api, email } = await registerUser("account");
  const account = (await api.get("/api/auth/me")).json.user;

  await test("安全响应头：nosniff / DENY / no-referrer / Permissions-Policy", async () => {
    const response = await fetch(`${API}/api/health`);
    eq(response.headers.get("x-content-type-options"), "nosniff", "nosniff");
    eq(response.headers.get("x-frame-options"), "DENY", "X-Frame-Options");
    eq(response.headers.get("referrer-policy"), "no-referrer", "Referrer-Policy");
    assert(
      (response.headers.get("permissions-policy") ?? "").includes("camera=()"),
      `Permissions-Policy=${response.headers.get("permissions-policy")}`,
    );
    // 开发环境不设 CSP，避免打断 Vite HMR
    eq(response.headers.get("content-security-policy"), null, "开发 CSP");
  });

  const { page } = await newPage(browser, { cookie: api.sessionCookie });
  await openBoards(page);

  await test("顶栏账号胶囊打开账号设置，回填昵称与邮箱", async () => {
    await page.click('[data-testid="boards-user"]');
    await page.waitForSelector('[data-testid="account-dialog"]', { timeout: 5000 });
    eq(await page.$eval('[data-testid="account-display-name"]', (el) => el.value), account.displayName, "昵称回填");
    const text = await page.$eval('[data-testid="account-dialog"]', (el) => el.textContent ?? "");
    assert(text.includes(email), "弹窗应展示邮箱");
  });

  await test("改显示名：保存后顶栏与接口同步", async () => {
    await setInputValue(page, '[data-testid="account-display-name"]', "樱花旅人");
    await page.click('[data-testid="account-save-profile"]');
    await until(
      async () => (await page.$eval('[data-testid="boards-user"]', (el) => el.textContent ?? "")).trim() === "樱花旅人",
      { label: "顶栏昵称更新" },
    );
    const me = await api.get("/api/auth/me");
    eq(me.json.user.displayName, "樱花旅人", "接口昵称");
  });

  await test("资料校验：1 个字不发请求并提示", async () => {
    const before = (await api.get("/api/auth/me")).json.user.displayName;
    await setInputValue(page, '[data-testid="account-display-name"]', "短");
    await page.click('[data-testid="account-save-profile"]');
    await page.waitForSelector('[data-testid="account-dialog"] [role="alert"]', { timeout: 3000 });
    eq((await api.get("/api/auth/me")).json.user.displayName, before, "接口昵称不应变化");
  });

  await test("首页账号菜单同样能打开账号设置", async () => {
    const { page: homePage } = await newPage(browser, { cookie: api.sessionCookie });
    await homePage.goto(`${WEB}/`, { waitUntil: "networkidle2" });
    await homePage.waitForSelector('[data-testid="home-user"]', { timeout: 10_000 });
    await homePage.click('[data-testid="home-user"]');
    await homePage.waitForSelector('[data-testid="home-account-settings"]', { timeout: 5000 });
    await homePage.click('[data-testid="home-account-settings"]');
    await homePage.waitForSelector('[data-testid="account-dialog"]', { timeout: 5000 });
  });

  await test("改密：其它会话失效、当前页仍在线、旧密码不能登录", async () => {
    const other = new Api("account-other");
    await other.login(email);

    await setInputValue(page, '[data-testid="account-current-password"]', PASSWORD);
    await setInputValue(page, '[data-testid="account-new-password"]', NEW_PASSWORD);
    await setInputValue(page, '[data-testid="account-confirm-password"]', NEW_PASSWORD);
    await page.click('[data-testid="account-save-password"]');
    await page.waitForFunction(
      () => (document.body.textContent ?? "").includes("密码已更新"),
      { timeout: 10_000 },
    );

    eq((await other.get("/api/auth/me")).status, 401, "其它会话");
    const currentStatus = await page.evaluate(async () => (await fetch("/api/auth/me")).status);
    eq(currentStatus, 200, "当前标签页会话");

    const oldLogin = new Api("account-old-login");
    const oldResult = await oldLogin.post("/api/auth/login", { email, password: PASSWORD });
    eq(oldResult.status, 401, "旧密码登录");

    const newLogin = new Api("account-new-login");
    eq((await newLogin.post("/api/auth/login", { email, password: NEW_PASSWORD })).status, 200, "新密码登录");
  });

  await page.click('[data-testid="account-dialog"] .wb-dialog-close');

  // ---------- 销号（界面链路） ----------
  const victim = await registerUser("account-delete");
  const victimUser = victim.user.user ?? victim.user;
  const board = await victim.api.createBoard({ title: "销号测试板" });
  const boardId = board.json.id;
  const { page: victimPage } = await newPage(browser, { cookie: victim.api.sessionCookie });
  await openBoards(victimPage);

  await test("销号：密码为空按钮禁用；错误密码 401，数据保留", async () => {
    await victimPage.click('[data-testid="boards-user"]');
    await victimPage.waitForSelector('[data-testid="account-dialog"]');
    eq(await victimPage.$eval('[data-testid="account-delete"]', (el) => el.disabled), true, "空密码按钮");
    await setInputValue(victimPage, '[data-testid="account-delete-password"]', "WrongPass#2026");
    eq(await victimPage.$eval('[data-testid="account-delete"]', (el) => el.disabled), false, "填密码后按钮");
    await victimPage.click('[data-testid="account-delete"]');
    await victimPage.waitForSelector('[data-testid="account-dialog"] [role="alert"]', { timeout: 5000 });
    const alert = await victimPage.$eval('[data-testid="account-dialog"] [role="alert"]', (el) => el.textContent ?? "");
    assert(alert.includes("当前密码不正确"), `提示=${alert}`);
    eq((await victim.api.get("/api/auth/me")).status, 200, "会话应保留");
    eq((await victim.api.list()).json.boards.length, 1, "白板应保留");
  });

  await test("销号成功：回首页、用户行停用、业务数据物理删除、邮箱可复用", async () => {
    await setInputValue(victimPage, '[data-testid="account-delete-password"]', PASSWORD);
    await Promise.all([
      victimPage.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15_000 }),
      victimPage.click('[data-testid="account-delete"]'),
    ]);
    assert(new URL(victimPage.url()).pathname === "/", `销号后应回首页，实际 ${victimPage.url()}`);

    const { rows } = await query(
      "select id, status, display_name, email from users where id = $1",
      [victimUser.id],
    );
    const row = rows[0];
    eq(row?.status, "disabled", "用户行状态");
    eq(row?.display_name, "已注销用户", "昵称");
    eq(row?.email, `deleted+${victimUser.id}@deleted.invalid`, "占位邮箱");

    const { rows: boards } = await query("select count(*)::int as n from boards where id = $1", [boardId]);
    eq(boards[0].n, 0, "白板应物理删除");
    const { rows: credentials } = await query("select count(*)::int as n from credentials where user_id = $1", [
      victimUser.id,
    ]);
    eq(credentials[0].n, 0, "口令凭据应删除");
    const { rows: spaces } = await query("select count(*)::int as n from spaces where owner_id = $1", [
      victimUser.id,
    ]);
    eq(spaces[0].n, 0, "个人空间应删除");

    eq((await victim.api.get("/api/auth/me")).status, 401, "旧会话");
    const relogin = new Api("account-relogin");
    eq((await relogin.post("/api/auth/login", { email: victim.email, password: PASSWORD })).status, 401, "停用账号登录");
    const again = new Api("account-again");
    eq(
      (await again.post("/api/auth/register", { email: victim.email, password: PASSWORD, displayName: "重来一次" })).status,
      201,
      "同邮箱重新注册",
    );
  });

  // ---------- 团队空间所有者拦截（接口链路） ----------
  await test("团队空间还有其他成员：销号 409；解散后可注销", async () => {
    const owner = await registerUser("account-team-owner");
    const member = await registerUser("account-team-member");
    const space = await owner.api.createSpace(`account-space-${Date.now()}`);
    const invite = await owner.api.invite(space.json.id, "editor");
    await member.api.acceptInvite(invite.json.token);

    const blocked = await owner.api.delete("/api/auth/me", { currentPassword: PASSWORD });
    eq(blocked.status, 409, "多人空间应拦截");
    eq(blocked.json.error.code, "SPACE_OWNERSHIP_REQUIRED", "错误码");

    eq((await owner.api.delete(`/api/spaces/${space.json.id}`)).status, 200, "解散空间");
    eq((await owner.api.delete("/api/auth/me", { currentPassword: PASSWORD })).status, 200, "解散后注销");
    eq((await owner.api.get("/api/auth/me")).status, 401, "注销后会话");

    const reuse = new Api("account-team-reuse");
    eq(
      (await reuse.post("/api/auth/register", { email: owner.email, password: PASSWORD, displayName: "空间主人重来" }))
        .status,
      201,
      "团队空间所有者邮箱复用",
    );
  });
} finally {
  await browser.close();
}

finish("account");
