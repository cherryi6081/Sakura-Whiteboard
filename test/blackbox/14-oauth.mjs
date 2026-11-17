#!/usr/bin/env node
/**
 * GitHub OAuth 黑盒（开发文档 §13.1）。
 *
 * 真实联调需要 GitHub 凭据；这里用本地假 provider + 独立 API 实例跑通：
 * - 回调合并：GitHub 已验证邮箱命中已有密码账号 → 绑定挂到老用户，不新建；
 * - 回调新建：邮箱未命中 → 新建用户并绑定；
 * - 失败路径：邮箱未验证 / state 不匹配 / 授权码过期 / 取消授权 / GitHub 5xx；
 * - 防重放：同一 state 第二次回调必须失败；
 * - 缺配置：独立无凭据实例 /api/auth/providers 返回 github:false，登录页不渲染入口；
 * - 回调跳转：成功 / 失败都落在 WEB_APP_ORIGIN（此处用 API 自身地址模拟跨端口），
 *   非法 returnTo 回落到安全默认页。
 */
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { API, REPO_ROOT, WEB } from "../lib/config.mjs";
import { launchBrowser, newPage } from "../lib/browser.mjs";
import { closePool, query } from "../lib/db.mjs";

const RUN = Date.now();
const MERGE_EMAIL = `oauth-merge-${RUN}@example.com`;
const NEW_EMAIL = `oauth-new-${RUN}@example.com`;
const UNVERIFIED_EMAIL = `oauth-unverified-${RUN}@example.com`;
const GH_MERGE_ID = String(800000000 + (RUN % 100000000));
const GH_NEW_ID = String(Number(GH_MERGE_ID) + 1);
const GH_UNVERIFIED_ID = String(Number(GH_MERGE_ID) + 2);

const API_PORT = 18085;
const PROVIDER_PORT = 18086;
const HIDDEN_PORT = 18087;
const OAUTH_BASE = `http://127.0.0.1:${API_PORT}`;
const PROVIDER_BASE = `http://127.0.0.1:${PROVIDER_PORT}`;
const HIDDEN_BASE = `http://127.0.0.1:${HIDDEN_PORT}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let stepIndex = 0;
function pass(label) {
  stepIndex += 1;
  console.log(`PASS  ${label} (${stepIndex})`);
}
function check(condition, message) {
  if (!condition) throw new Error(message);
}

// ---------- 假 GitHub ----------
let lastTokenForm = null;
const provider = http.createServer((req, res) => {
  const url = new URL(req.url, PROVIDER_BASE);
  if (req.method === "POST" && url.pathname === "/login/oauth/access_token") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      lastTokenForm = new URLSearchParams(body);
      const code = lastTokenForm.get("code");
      if (code === "boom") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "boom" }));
        return;
      }
      if (code !== "good-merge" && code !== "good-new" && code !== "unverified") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "bad_verification_code", error_description: "code expired" }));
        return;
      }
      const token = code === "good-merge" ? "tok-merge" : code === "good-new" ? "tok-new" : "tok-unverified";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: token, token_type: "bearer", scope: "read:user,user:email" }));
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/user") {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const users = {
      "tok-merge": { id: Number(GH_MERGE_ID), login: "octo-merge", name: "Octo Merge", avatar_url: null },
      "tok-new": { id: Number(GH_NEW_ID), login: "octo-new", name: "Octo New", avatar_url: null },
      "tok-unverified": { id: Number(GH_UNVERIFIED_ID), login: "octo-unv", name: "Octo Unverified", avatar_url: null },
    };
    const user = users[token];
    res.writeHead(user ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify(user ?? { message: "Bad credentials" }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/user/emails") {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const emails = {
      "tok-merge": [{ email: MERGE_EMAIL, primary: true, verified: true }],
      "tok-new": [{ email: NEW_EMAIL, primary: true, verified: true }],
      "tok-unverified": [{ email: UNVERIFIED_EMAIL, primary: true, verified: false }],
    };
    const value = emails[token];
    res.writeHead(value ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify(value ?? { message: "Bad credentials" }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ message: "not found" }));
});

// ---------- HTTP 小工具 ----------
function cookiesOf(res) {
  if (typeof res.headers.getSetCookie === "function") return res.headers.getSetCookie();
  const raw = res.headers.get("set-cookie");
  return raw ? [raw] : [];
}
function cookieValue(res, name) {
  for (const line of cookiesOf(res)) {
    const match = new RegExp(`(?:^|,\\s*)${name}=([^;,]*)`).exec(line);
    if (match) return decodeURIComponent(match[1]);
  }
  return null;
}
async function startFlow(next = "/boards") {
  const res = await fetch(`${OAUTH_BASE}/api/auth/github/start?next=${encodeURIComponent(next)}`, {
    redirect: "manual",
  });
  const location = res.headers.get("location") || "";
  const stateCookie = cookieValue(res, "wb_oauth_state");
  const state = new URL(location).searchParams.get("state");
  return { res, location, state, stateCookie };
}
async function startWithCookie(next, stateCookie) {
  const res = await fetch(`${OAUTH_BASE}/api/auth/github/start?next=${encodeURIComponent(next)}`, {
    headers: stateCookie ? { cookie: `wb_oauth_state=${stateCookie}` } : {},
    redirect: "manual",
  });
  const location = res.headers.get("location") || "";
  return { res, location, state: new URL(location).searchParams.get("state"), stateCookie: cookieValue(res, "wb_oauth_state") };
}
async function callback(params, stateCookie) {
  const search = new URLSearchParams(params);
  return fetch(`${OAUTH_BASE}/api/auth/github/callback?${search.toString()}`, {
    headers: stateCookie ? { cookie: `wb_oauth_state=${stateCookie}` } : {},
    redirect: "manual",
  });
}
async function meWith(cookie) {
  const res = await fetch(`${OAUTH_BASE}/api/auth/me`, { headers: { cookie: `wb_sess=${cookie}` } });
  return { status: res.status, body: await res.json().catch(() => null) };
}
function locationOf(res) {
  return res.headers.get("location") || "";
}
function checkLoginError(res, code, label, base = OAUTH_BASE) {
  const location = locationOf(res);
  const target = new URL(location, base);
  check(target.origin === base && target.pathname === "/login", `${label}: 应回登录页，实际 ${location}`);
  check(target.searchParams.get("oauthError") === code, `${label}: 错误码应为 ${code}，实际 ${location}`);
  check(!cookieValue(res, "wb_sess"), `${label}: 失败时不应种会话`);
}

let child = null;
let unconfiguredChild = null;
let browser = null;
const serverLogs = [];

try {
  await new Promise((resolve) => provider.listen(PROVIDER_PORT, "127.0.0.1", resolve));

  const tsxCli = path.join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs");
  child = spawn(process.execPath, [tsxCli, "apps/server/src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(API_PORT),
      INSTANCE_ID: `oauth-${RUN}`,
      WEB_DIST: path.join(REPO_ROOT, "apps/web/dist"),
      GITHUB_CLIENT_ID: "test-client-id",
      GITHUB_CLIENT_SECRET: "test-client-secret",
      GITHUB_REDIRECT_URI: `${OAUTH_BASE}/api/auth/github/callback`,
      GITHUB_OAUTH_BASE_URL: PROVIDER_BASE,
      GITHUB_API_BASE_URL: PROVIDER_BASE,
      // 回调后的最终跳转必须落到「前端来源」，这里用 API 自身地址模拟跨端口
      WEB_APP_ORIGIN: OAUTH_BASE,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => serverLogs.push(String(chunk)));
  child.stderr.on("data", (chunk) => serverLogs.push(String(chunk)));

  let healthy = false;
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${OAUTH_BASE}/api/health`);
      if (res.ok) {
        healthy = true;
        break;
      }
    } catch {
      // 还没起来
    }
    await sleep(500);
  }
  check(healthy, `独立 API 未就绪：\n${serverLogs.join("").slice(-2000)}`);
  pass("独立 API 启动，假 provider 就绪");

  // 预置一个密码账号，用于「按已验证邮箱合并」
  const registerRes = await fetch(`${OAUTH_BASE}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: MERGE_EMAIL, password: "Xk7#mQ2vLp9wZ", displayName: "已有账号" }),
  });
  const registered = await registerRes.json();
  check(registerRes.status === 201, `预置账号失败：${registerRes.status} ${JSON.stringify(registered)}`);
  const mergeUserId = registered.user.id;

  // ---------- 合并路径 ----------
  const mergeFlow = await startFlow("/boards");
  check(mergeFlow.res.status === 302, `start 应 302，实际 ${mergeFlow.res.status}`);
  check(mergeFlow.location.startsWith(`${PROVIDER_BASE}/login/oauth/authorize`), `授权地址错误：${mergeFlow.location}`);
  const authorize = new URL(mergeFlow.location);
  check(authorize.searchParams.get("client_id") === "test-client-id", "授权地址缺 client_id");
  check(authorize.searchParams.get("scope") === "read:user user:email", "授权地址 scope 错误");
  check(authorize.searchParams.get("code_challenge_method") === "S256", "缺 PKCE S256");
  check(authorize.searchParams.get("prompt") === "select_account", "授权地址应带 prompt=select_account，否则已登录 GitHub 会自动跳过换号");
  check(Boolean(mergeFlow.state && mergeFlow.stateCookie), "缺 state / state cookie");
  check(mergeFlow.state === mergeFlow.stateCookie, "state 与 cookie 不一致");

  const mergeCb = await callback({ code: "good-merge", state: mergeFlow.state }, mergeFlow.stateCookie);
  check(mergeCb.status === 302, `回调应 302，实际 ${mergeCb.status}`);
  check(locationOf(mergeCb) === `${OAUTH_BASE}/boards`, `应回前端来源 + /boards，实际 ${locationOf(mergeCb)}`);
  const mergeSess = cookieValue(mergeCb, "wb_sess");
  check(Boolean(mergeSess), "合并路径未种会话");

  const mergeMe = await meWith(mergeSess);
  check(mergeMe.status === 200, `合并后 me 应 200，实际 ${mergeMe.status}`);
  check(mergeMe.body.user.id === mergeUserId, "合并应复用原账号，不应新建");
  check(mergeMe.body.user.email === MERGE_EMAIL, "合并后邮箱不一致");
  check(mergeMe.body.loginMethod === "oauth:github", `loginMethod 应为 oauth:github，实际 ${mergeMe.body.loginMethod}`);
  check(mergeMe.body.methods.includes("password") && mergeMe.body.methods.includes("github"), "methods 应同时含 password / github");

  const binding = await query(
    "select user_id, provider_email, provider_email_verified from oauth_accounts where provider = 'github' and provider_user_id = $1",
    [GH_MERGE_ID],
  );
  check(binding.rows.length === 1 && binding.rows[0].user_id === mergeUserId, "oauth_accounts 未挂到老用户");
  const sameEmail = await query("select count(*)::int as n from users where email = $1", [MERGE_EMAIL]);
  check(sameEmail.rows[0].n === 1, "合并路径不应产生第二个同邮箱用户");

  const verifier = lastTokenForm?.get("code_verifier");
  const derived = verifier ? (await import("node:crypto")).createHash("sha256").update(verifier).digest("base64url") : "";
  check(Boolean(verifier), "token 请求缺 code_verifier");
  check(derived === authorize.searchParams.get("code_challenge"), "PKCE challenge 与 verifier 不匹配");
  check(lastTokenForm?.get("redirect_uri") === `${OAUTH_BASE}/api/auth/github/callback`, "token 请求 redirect_uri 不一致");
  pass("合并路径：已验证邮箱命中老账号，绑定挂上且未新建");

  // ---------- 新建路径 ----------
  const newFlow = await startFlow("/");
  const newCb = await callback({ code: "good-new", state: newFlow.state }, newFlow.stateCookie);
  check(locationOf(newCb) === `${OAUTH_BASE}/`, `新建路径应回前端来源 /，实际 ${locationOf(newCb)}`);
  const newSess = cookieValue(newCb, "wb_sess");
  check(Boolean(newSess), "新建路径未种会话");
  const newMe = await meWith(newSess);
  check(newMe.status === 200, `新建后 me 应 200，实际 ${newMe.status}`);
  check(newMe.body.user.email === NEW_EMAIL, `新用户邮箱应为 ${NEW_EMAIL}，实际 ${newMe.body.user.email}`);
  check(newMe.body.user.displayName === "Octo New", `新用户昵称应取 GitHub name，实际 ${newMe.body.user.displayName}`);
  check(newMe.body.methods.length === 1 && newMe.body.methods[0] === "github", "新用户 methods 应只有 github");
  const newBinding = await query(
    "select user_id from oauth_accounts where provider = 'github' and provider_user_id = $1",
    [GH_NEW_ID],
  );
  check(newBinding.rows.length === 1 && newBinding.rows[0].user_id === newMe.body.user.id, "新用户未写入 oauth_accounts");
  pass("新建路径：邮箱未命中 → 新建用户并绑定，loginMethod=oauth:github");

  // ---------- 失败路径 ----------
  const unverifiedFlow = await startFlow("/boards");
  const unverifiedCb = await callback({ code: "unverified", state: unverifiedFlow.state }, unverifiedFlow.stateCookie);
  checkLoginError(unverifiedCb, "email_unverified", "邮箱未验证");
  const unverifiedUser = await query("select count(*)::int as n from users where email = $1", [UNVERIFIED_EMAIL]);
  check(unverifiedUser.rows[0].n === 0, "邮箱未验证时不应建号");
  pass("失败路径：邮箱未验证 → email_unverified，不建号");

  const expiredFlow = await startFlow("/boards");
  const expiredCb = await callback({ code: "expired", state: expiredFlow.state }, expiredFlow.stateCookie);
  checkLoginError(expiredCb, "code_expired", "授权码过期");
  pass("失败路径：授权码过期 → code_expired");

  const deniedFlow = await startFlow("/boards");
  const deniedCb = await callback(
    { error: "access_denied", state: deniedFlow.state },
    deniedFlow.stateCookie,
  );
  checkLoginError(deniedCb, "access_denied", "取消授权");
  pass("失败路径：用户取消授权 → access_denied");

  const boomFlow = await startFlow("/boards");
  const boomCb = await callback({ code: "boom", state: boomFlow.state }, boomFlow.stateCookie);
  checkLoginError(boomCb, "github_error", "GitHub 5xx");
  pass("失败路径：GitHub 5xx → github_error");

  const mismatchFlow = await startFlow("/boards");
  const mismatchCb = await callback({ code: "good-new", state: "not-the-state" }, mismatchFlow.stateCookie);
  checkLoginError(mismatchCb, "state_mismatch", "state 不匹配");
  const noCookieCb = await callback({ code: "good-new", state: mismatchFlow.state }, null);
  checkLoginError(noCookieCb, "state_mismatch", "缺 state cookie");
  pass("失败路径：state 不匹配 / 缺 cookie → state_mismatch");

  // 同一 state 重放
  const replayFlow = await startFlow("/boards");
  const firstCb = await callback({ code: "good-new", state: replayFlow.state }, replayFlow.stateCookie);
  check(firstCb.status === 302 && Boolean(cookieValue(firstCb, "wb_sess")), "重放测试的首次回调应成功");
  const replayCb = await callback({ code: "good-new", state: replayFlow.state }, replayFlow.stateCookie);
  // 首次回调成功后服务端已把该 state 从 cookie 与 Redis 一起摘掉：属「已过期/已使用」，不是来源不明
  checkLoginError(replayCb, "state_expired", "state 重放");
  pass("防重放：同一 state 第二次回调 → state_expired");

  // 连点两次「使用 GitHub 登录」：两个 state 并存，先回来的那条不应被覆盖
  const firstTap = await startFlow("/boards");
  const secondTap = await startWithCookie("/boards", firstTap.stateCookie);
  check(secondTap.stateCookie.split(".").includes(firstTap.state), `第二次 start 应保留第一个 state，实际 ${secondTap.stateCookie}`);
  const firstBack = await callback({ code: "good-merge", state: firstTap.state }, secondTap.stateCookie);
  check(firstBack.status === 302 && Boolean(cookieValue(firstBack, "wb_sess")), "先回来的 state 应能完成登录");
  const remainingCookie = cookieValue(firstBack, "wb_oauth_state");
  check(remainingCookie === secondTap.state, `消费后 cookie 应只保留未用的 state，实际 ${remainingCookie}`);
  const secondBack = await callback({ code: "good-merge", state: secondTap.state }, remainingCookie);
  check(secondBack.status === 302 && Boolean(cookieValue(secondBack, "wb_sess")), "后回来的 state 也应能完成登录");
  pass("连点两次：两个 state 并存，先回来的与后回来的都能登录");

  // ---------- 非法 returnTo ----------
  const evilFlow = await startFlow("//evil.com/steal");
  const evilCb = await callback({ code: "good-merge", state: evilFlow.state }, evilFlow.stateCookie);
  check(locationOf(evilCb) === `${OAUTH_BASE}/`, `非法 returnTo 应回落到 /，实际 ${locationOf(evilCb)}`);
  pass("开放重定向防护：非法 returnTo 回落到安全默认页");

  // ---------- 缺配置（独立无凭据实例） ----------
  const hiddenChild = spawn(process.execPath, [tsxCli, "apps/server/src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(HIDDEN_PORT),
      INSTANCE_ID: `oauth-hidden-${RUN}`,
      WEB_DIST: path.join(REPO_ROOT, "apps/web/dist"),
      GITHUB_CLIENT_ID: "",
      GITHUB_CLIENT_SECRET: "",
      GITHUB_REDIRECT_URI: `${HIDDEN_BASE}/api/auth/github/callback`,
      WEB_APP_ORIGIN: HIDDEN_BASE,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  hiddenChild.stdout.on("data", (chunk) => serverLogs.push(String(chunk)));
  hiddenChild.stderr.on("data", (chunk) => serverLogs.push(String(chunk)));
  let hiddenHealthy = false;
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${HIDDEN_BASE}/api/health`);
      if (res.ok) {
        hiddenHealthy = true;
        break;
      }
    } catch {
      // 还没起来
    }
    await sleep(500);
  }
  check(hiddenHealthy, `无凭据实例未就绪：\n${serverLogs.join("").slice(-2000)}`);
  unconfiguredChild = hiddenChild;

  const providers = await fetch(`${HIDDEN_BASE}/api/auth/providers`).then((res) => res.json());
  check(providers.github === false, `无凭据实例应未配置 GitHub，实际 ${JSON.stringify(providers)}`);
  const startUnconfigured = await fetch(`${HIDDEN_BASE}/api/auth/github/start?next=/boards`, {
    redirect: "manual",
  });
  check(startUnconfigured.status === 302, "缺配置时 start 应 302 回登录页");
  checkLoginError(startUnconfigured, "not_configured", "缺配置 start", HIDDEN_BASE);
  pass("缺配置：providers github:false，start → not_configured");

  // ---------- 登录页入口与错误文案 ----------
  browser = await launchBrowser();

  const { context: contextHidden, page: pageHidden } = await newPage(browser, { width: 1440, height: 900 });
  await pageHidden.goto(`${HIDDEN_BASE}/login`, { waitUntil: "networkidle2" });
  await pageHidden.waitForSelector('[data-testid="auth-card"]', { timeout: 20_000 });
  await sleep(300);
  check((await pageHidden.$('[data-testid="auth-github"]')) === null, "未配置时登录页不应显示 GitHub 入口");
  await contextHidden.close();
  pass("缺配置界面：登录页不渲染 GitHub 按钮");

  const { context: contextShown, page: pageShown } = await newPage(browser, { width: 1440, height: 900 });
  await pageShown.setRequestInterception(true);
  pageShown.on("request", (request) => {
    if (request.url().endsWith("/api/auth/providers")) {
      void request.respond({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ github: true }),
      });
      return;
    }
    void request.continue();
  });
  await pageShown.goto(`${WEB}/login?next=/boards/trash`, { waitUntil: "networkidle2" });
  await pageShown.waitForSelector('[data-testid="auth-github"]', { timeout: 20_000 });
  const href = await pageShown.$eval('[data-testid="auth-github"]', (el) => el.getAttribute("href"));
  check(href === "/api/auth/github/start?next=%2Fboards%2Ftrash", `GitHub 入口 href 错误：${href}`);
  await contextShown.close();
  pass("已配置界面（拦截 providers）：登录页出现 GitHub 入口并带 returnTo");

  const { context: contextError, page: pageError } = await newPage(browser, { width: 1440, height: 900 });
  await pageError.goto(`${WEB}/login?oauthError=email_unverified`, { waitUntil: "networkidle2" });
  await pageError.waitForSelector('[data-testid="auth-error"]', { timeout: 20_000 });
  const errorText = await pageError.$eval('[data-testid="auth-error"]', (el) => el.textContent || "");
  check(errorText.includes("没有已验证的邮箱"), `错误文案未渲染：${errorText}`);
  check(!pageError.url().includes("oauthError"), "错误码应从地址栏清掉");
  await contextError.close();
  pass("失败界面：oauthError 渲染为可读文案并从 URL 清除");

  console.log(`\nGitHub OAuth 黑盒完成（${stepIndex} 项）`);
} catch (error) {
  console.error(`\nFAIL  ${error.message}`);
  if (serverLogs.length) console.error(`\n--- api logs ---\n${serverLogs.join("").slice(-3000)}`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => undefined);
  if (child) child.kill("SIGTERM");
  if (unconfiguredChild) unconfiguredChild.kill("SIGTERM");
  await new Promise((resolve) => provider.close(resolve));
  await closePool().catch(() => undefined);
}
