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
 * Google OAuth（OpenID Connect 授权码 + PKCE）。
 *
 * 与 GitHub 同一套口径：state 落 Redis 一次性消费、cookie 保留多个候选、`b~` 前缀表示绑定。
 * 差异只在端点和资料字段：
 * - 授权：`https://accounts.google.com/o/oauth2/v2/auth`
 * - 换 token：`https://oauth2.googleapis.com/token`
 * - 用户资料：`https://openidconnect.googleapis.com/v1/userinfo`（`sub` / `email` / `email_verified`）
 *
 * 只接受 Google 侧 `email_verified === true` 的邮箱；否则明确失败，不静默建号。
 */

export const GOOGLE_STATE_COOKIE = 'wb_oauth_state_google';
export const GOOGLE_SCOPE = 'openid email profile';

const STATE_COOKIE = { name: GOOGLE_STATE_COOKIE, path: '/api/auth/google' };

export type GoogleProfile = {
  id: string;
  /** Google 没有 login 字段，统一用邮箱前缀做展示兜底。 */
  login: string;
  name: string | null;
  avatarUrl: string | null;
  email: string;
};

export function googleConfigured(): boolean {
  return Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET);
}

/** 注册到 Google 的重定向 URI：显式配置优先，否则按代理头推导。 */
export function googleRedirectUri(req: Request): string {
  if (config.GOOGLE_REDIRECT_URI) return config.GOOGLE_REDIRECT_URI;
  return `${requestOrigin(req)}/api/auth/google/callback`;
}

export function buildGoogleStateCookie(states: string[]): string {
  return buildStateCookie(STATE_COOKIE, states);
}

export function clearGoogleStateCookie(): string {
  return clearStateCookie(STATE_COOKIE);
}

export function saveGoogleState(state: string, record: OAuthStateRecord): Promise<void> {
  return saveState('google', state, record);
}

export function consumeGoogleState(state: string): Promise<OAuthStateRecord | null> {
  return consumeState('google', state);
}

export function authorizeUrl(input: { state: string; redirectUri: string; challenge: string }): string {
  const url = new URL('/o/oauth2/v2/auth', config.GOOGLE_OAUTH_BASE_URL);
  url.searchParams.set('client_id', config.GOOGLE_CLIENT_ID ?? '');
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_SCOPE);
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // 同 GitHub：强制账号选择器，避免已登录会话直接静默回跳
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

type UserInfoPayload = {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
};

const googleFetch = createOutboundFetch({
  proxyUrl: config.GOOGLE_PROXY,
  label: 'google',
  unreachableCode: 'google_unreachable',
});

/** 授权码换 access token；`invalid_grant` 归类为授权码过期。 */
export async function exchangeCode(input: { code: string; redirectUri: string; verifier: string }): Promise<string> {
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) {
    throw new OAuthError('not_configured');
  }
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.GOOGLE_CLIENT_ID,
    client_secret: config.GOOGLE_CLIENT_SECRET,
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.verifier,
  });
  const res = await googleFetch(new URL('/token', config.GOOGLE_TOKEN_BASE_URL), {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'whiteboard-oauth',
    },
    body,
  });
  // Google 的 invalid_grant 走 400 响应体，必须先解析错误体再按状态码兜底
  const data = (await res.json().catch(() => null)) as TokenPayload | null;
  if (data?.error) {
    const code = data.error === 'invalid_grant' ? 'code_expired' : 'google_error';
    throw new OAuthError(code, data.error_description ?? data.error);
  }
  if (!res.ok) throw new OAuthError('google_error', `google token endpoint ${res.status}`);
  if (!data) throw new OAuthError('google_error', 'google token response is not json');
  if (!data.access_token) throw new OAuthError('google_error', 'missing access_token');
  return data.access_token;
}

export async function fetchGoogleProfile(token: string): Promise<GoogleProfile> {
  const res = await googleFetch(new URL('/v1/userinfo', config.GOOGLE_API_BASE_URL), {
    method: 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'user-agent': 'whiteboard-oauth',
    },
  });
  if (!res.ok) throw new OAuthError('google_error', `google userinfo ${res.status}`);
  const data = (await res.json().catch(() => null)) as UserInfoPayload | null;
  if (!data || typeof data.sub !== 'string' || !data.sub) {
    throw new OAuthError('google_error', 'google user payload incomplete');
  }
  if (typeof data.email !== 'string' || !data.email) {
    throw new OAuthError('email_unverified');
  }
  if (data.email_verified !== true) throw new OAuthError('email_unverified');

  const email = data.email.trim().toLowerCase();
  return {
    id: data.sub,
    login: email.split('@')[0] ?? email,
    name: data.name ?? null,
    avatarUrl: data.picture ?? null,
    email,
  };
}

/** 失败统一回登录页，带错误码、provider 与可重试的站内落点。 */
export function loginErrorRedirect(code: string, next: string | null): string {
  const params = new URLSearchParams({ oauthError: code, oauth: 'google' });
  const safe = safeReturnTo(next);
  if (safe) params.set('next', safe);
  return `/login?${params.toString()}`;
}

export function loginErrorUrl(req: Request, code: string, next: string | null): string {
  return webAppUrl(req, loginErrorRedirect(code, next));
}
