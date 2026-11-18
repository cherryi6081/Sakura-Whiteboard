import type { Request } from 'express';
import { config } from '../config.js';
import {
  OAuthError,
  createOutboundFetch,
  type OAuthStateRecord,
  buildStateCookie,
  clearStateCookie,
  consumeState,
  requestOrigin,
  safeReturnTo,
  saveState,
  webAppUrl,
} from './oauthShared.js';

/**
 * GitHub OAuth（开发文档 §4.1.1 / §13.1）。
 *
 * 只做最小闭环：授权跳转 → 回调换 token → 拉取用户与已验证邮箱 → 绑定或合并。
 * - 配置驱动：`GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` 缺一即视为未启用。
 * - state 落 Redis（一次性消费）并额外绑定 HttpOnly cookie，防登录 CSRF 与重放。
 * - PKCE：GitHub OAuth App 支持 S256，verifier 与 state 同存 Redis，不落浏览器。
 * - 错误不静默：统一 302 回登录页并带 `oauthError=<code>`，由前端翻成可读文案。
 *
 * state / PKCE / 回跳地址等与 Google 共用的部分在 `oauthShared.ts`；
 * 本文件只保留 GitHub 特有的端点、scope 与用户资料解析。
 */

export const GITHUB_STATE_COOKIE = 'wb_oauth_state';
export const GITHUB_SCOPE = 'read:user user:email';

const STATE_COOKIE = { name: GITHUB_STATE_COOKIE, path: '/api/auth/github' };

export type GithubProfile = {
  id: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  email: string;
};

export function githubConfigured(): boolean {
  return Boolean(config.GITHUB_CLIENT_ID && config.GITHUB_CLIENT_SECRET);
}

/** 注册到 GitHub 的回调地址：显式配置优先，否则按代理头推导。 */
export function githubRedirectUri(req: Request): string {
  if (config.GITHUB_REDIRECT_URI) return config.GITHUB_REDIRECT_URI;
  return `${requestOrigin(req)}/api/auth/github/callback`;
}

export function buildGithubStateCookie(states: string[]): string {
  return buildStateCookie(STATE_COOKIE, states);
}

export function clearGithubStateCookie(): string {
  return clearStateCookie(STATE_COOKIE);
}

export function saveGithubState(state: string, record: OAuthStateRecord): Promise<void> {
  return saveState('github', state, record);
}

export function consumeGithubState(state: string): Promise<OAuthStateRecord | null> {
  return consumeState('github', state);
}

export function authorizeUrl(input: { state: string; redirectUri: string; challenge: string }): string {
  const url = new URL('/login/oauth/authorize', config.GITHUB_OAUTH_BASE_URL);
  url.searchParams.set('client_id', config.GITHUB_CLIENT_ID ?? '');
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('scope', GITHUB_SCOPE);
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('allow_signup', 'true');
  // GitHub 会话已登录且 App 已授权时会静默回跳，用户无法换号；select_account 强制弹出账号选择器
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

type TokenPayload = {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
};

const githubFetch = createOutboundFetch({
  proxyUrl: config.GITHUB_PROXY,
  label: 'github',
  unreachableCode: 'github_unreachable',
});

/** 用授权码换 access token；GitHub 侧错误按可读语义映射。 */
export async function exchangeCode(input: { code: string; redirectUri: string; verifier: string }): Promise<string> {
  if (!config.GITHUB_CLIENT_ID || !config.GITHUB_CLIENT_SECRET) {
    throw new OAuthError('not_configured');
  }
  const body = new URLSearchParams({
    client_id: config.GITHUB_CLIENT_ID,
    client_secret: config.GITHUB_CLIENT_SECRET,
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.verifier,
  });
  const res = await githubFetch(new URL('/login/oauth/access_token', config.GITHUB_OAUTH_BASE_URL), {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'whiteboard-oauth',
    },
    body,
  });
  if (!res.ok) throw new OAuthError('github_error', `github token endpoint ${res.status}`);
  const data = (await res.json().catch(() => null)) as TokenPayload | null;
  if (!data) throw new OAuthError('github_error', 'github token response is not json');
  if (data.error) {
    const code = data.error === 'bad_verification_code' ? 'code_expired' : 'github_error';
    throw new OAuthError(code, data.error_description ?? data.error);
  }
  if (!data.access_token) throw new OAuthError('github_error', 'missing access_token');
  return data.access_token;
}

async function githubGet(path: string, token: string): Promise<unknown> {
  const res = await githubFetch(new URL(path, config.GITHUB_API_BASE_URL), {
    method: 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'whiteboard-oauth',
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!res.ok) throw new OAuthError('github_error', `github api ${path} ${res.status}`);
  return res.json().catch(() => null);
}

type GithubUser = { id?: number; login?: string; name?: string | null; avatar_url?: string | null };
type GithubEmail = { email?: string; primary?: boolean; verified?: boolean };

/** 只认 GitHub 侧 primary + verified 的邮箱；拿不到就明确失败，不静默建号。 */
export async function fetchGithubProfile(token: string): Promise<GithubProfile> {
  const [user, emails] = await Promise.all([
    githubGet('/user', token) as Promise<GithubUser | null>,
    githubGet('/user/emails', token) as Promise<GithubEmail[] | null>,
  ]);
  if (!user || typeof user.id !== 'number' || !user.login) {
    throw new OAuthError('github_error', 'github user payload incomplete');
  }
  const verified = (Array.isArray(emails) ? emails : []).find((item) => item.primary && item.verified)
    ?? (Array.isArray(emails) ? emails : []).find((item) => item.verified);
  if (!verified?.email) throw new OAuthError('email_unverified');

  return {
    id: String(user.id),
    login: user.login,
    name: user.name ?? null,
    avatarUrl: user.avatar_url ?? null,
    email: verified.email.trim().toLowerCase(),
  };
}

/** 失败统一回登录页，带错误码和可重试的站内落点。 */
export function loginErrorRedirect(code: string, next: string | null): string {
  const params = new URLSearchParams({ oauthError: code, oauth: 'github' });
  const safe = safeReturnTo(next);
  if (safe) params.set('next', safe);
  return `/login?${params.toString()}`;
}

/** 失败跳转也落在前端来源上，开发环境不会 404 在 API 端口。 */
export function loginErrorUrl(req: Request, code: string, next: string | null): string {
  return webAppUrl(req, loginErrorRedirect(code, next));
}

/** 供其它模块复用的公共导出（避免各处从两个文件拼装）。 */
export { createPkce, createState, isBindState, parseStateCookieValue } from './oauthShared.js';
