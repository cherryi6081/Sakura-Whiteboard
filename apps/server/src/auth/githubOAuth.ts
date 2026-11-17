import { createHash, randomBytes } from 'node:crypto';
import type { Request } from 'express';
import { fetch as undiciFetch, ProxyAgent } from 'undici';
import { config } from '../config.js';
import { logger } from '../infra/logger.js';
import { ensureRedisConnected, redis } from '../infra/redis.js';

/**
 * GitHub OAuth（开发文档 §4.1.1 / §13.1）。
 *
 * 只做最小闭环：授权跳转 → 回调换 token → 拉取用户与已验证邮箱 → 绑定或合并。
 * - 配置驱动：`GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` 缺一即视为未启用。
 * - state 落 Redis（一次性消费）并额外绑定 HttpOnly cookie，防登录 CSRF 与重放。
 * - PKCE：GitHub OAuth App 支持 S256，verifier 与 state 同存 Redis，不落浏览器。
 * - 错误不静默：统一 302 回登录页并带 `oauthError=<code>`，由前端翻成可读文案。
 */

export const GITHUB_STATE_COOKIE = 'wb_oauth_state';
export const GITHUB_SCOPE = 'read:user user:email';
// 真实联调发现：登录 + 2FA 常超过 10 分钟，联调时 16 分钟才回调导致 state 过期，放宽到 20 分钟
const STATE_TTL_SECONDS = 1200;
const STATE_KEY = (state: string) => `oauth:github:state:${state}`;

export type GithubOAuthErrorCode =
  | 'not_configured'
  | 'state_mismatch'
  | 'state_expired'
  | 'code_expired'
  | 'email_unverified'
  | 'account_disabled'
  | 'access_denied'
  | 'github_unreachable'
  | 'temporarily_unavailable'
  | 'github_error';

export class GithubOAuthError extends Error {
  constructor(
    public readonly code: GithubOAuthErrorCode,
    message: string = code,
  ) {
    super(message);
  }
}

export type GithubProfile = {
  id: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  email: string;
};

type StateRecord = {
  returnTo: string;
  codeVerifier: string;
  createdAt: number;
};

export function githubConfigured(): boolean {
  return Boolean(config.GITHUB_CLIENT_ID && config.GITHUB_CLIENT_SECRET);
}

/** 注册到 GitHub 的回调地址：显式配置优先，否则按代理头推导。 */
export function githubRedirectUri(req: Request): string {
  if (config.GITHUB_REDIRECT_URI) return config.GITHUB_REDIRECT_URI;
  const proto = req.get('x-forwarded-proto')?.split(',')[0]?.trim() || req.protocol;
  const host = req.get('x-forwarded-host')?.split(',')[0]?.trim() || req.get('host');
  return `${proto}://${host}/api/auth/github/callback`;
}

/** 只允许站内绝对路径，挡住 `//evil.com`、反斜杠与控制字符。 */
export function safeReturnTo(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return null;
  if (/[\u0000-\u001f]/.test(raw)) return null;
  return raw;
}

function requestOrigin(req: Request): string {
  const proto = req.get('x-forwarded-proto')?.split(',')[0]?.trim() || req.protocol;
  const host = req.get('x-forwarded-host')?.split(',')[0]?.trim() || req.get('host');
  return `${proto}://${host}`;
}

/**
 * 前端来源：显式配置优先，否则按请求同源（生产单域名部署）。
 * 开发环境由 `.env` 填 http://localhost:5173，避免回调后落到 API 端口。
 */
export function webAppOrigin(req: Request): string {
  return (config.WEB_APP_ORIGIN ?? requestOrigin(req)).replace(/\/+$/, '');
}

/** 把站内路径拼到前端来源，供回调后的浏览器跳转使用。 */
export function webAppUrl(req: Request, path: string): string {
  return `${webAppOrigin(req)}${path}`;
}

/**
 * state cookie 允许并存多个值（点号分隔，base64url 不含点）。
 *
 * 用户连点两次「使用 GitHub 登录」会先后开两条授权流程：若 cookie 只存最后一个 state，
 * 先回来的那条必然 state_mismatch。这里保留最近若干个候选，回调命中任意一个即可。
 */
const STATE_COOKIE_MAX = 5;

export function buildStateCookie(states: string[]): string {
  const secure = config.NODE_ENV === 'production' ? '; Secure' : '';
  const value = states.filter(Boolean).slice(-STATE_COOKIE_MAX).join('.');
  return `${GITHUB_STATE_COOKIE}=${value}; Path=/api/auth/github; Max-Age=${STATE_TTL_SECONDS}; HttpOnly${secure}; SameSite=Lax`;
}

export function parseStateCookieValue(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split('.')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(-STATE_COOKIE_MAX);
}

export function clearStateCookie(): string {
  const secure = config.NODE_ENV === 'production' ? '; Secure' : '';
  return `${GITHUB_STATE_COOKIE}=; Path=/api/auth/github; Max-Age=0; HttpOnly${secure}; SameSite=Lax`;
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function createState(): string {
  return randomBytes(24).toString('base64url');
}

export async function saveState(state: string, record: StateRecord): Promise<void> {
  await ensureRedisConnected();
  await redis.set(STATE_KEY(state), JSON.stringify(record), 'EX', STATE_TTL_SECONDS);
}

/** 一次性消费：读到即删，同一 state 无法二次回调。 */
export async function consumeState(state: string): Promise<StateRecord | null> {
  await ensureRedisConnected();
  const raw = await redis.getdel(STATE_KEY(state));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StateRecord>;
    if (typeof parsed.returnTo !== 'string' || typeof parsed.codeVerifier !== 'string') return null;
    return {
      returnTo: safeReturnTo(parsed.returnTo) ?? '/',
      codeVerifier: parsed.codeVerifier,
      createdAt: Number(parsed.createdAt ?? 0),
    };
  } catch {
    return null;
  }
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

type OutboundResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

const OUTBOUND_TIMEOUT_MS = 15_000;
const OUTBOUND_ATTEMPTS = 2;
const OUTBOUND_RETRY_DELAY_MS = 300;

let proxyDispatcher: ProxyAgent | undefined;
let proxyResolved = false;

/**
 * Node 自带 fetch **不读系统代理**（浏览器走的代理它拿不到），开发机上直连 github.com
 * 容易被网络层超时，于是换 token 失败。这里按配置显式注入代理：
 * `GITHUB_PROXY` 优先，其次标准 `HTTPS_PROXY` / `HTTP_PROXY`，都没有才直连。
 */
function outboundDispatcher(): ProxyAgent | undefined {
  if (proxyResolved) return proxyDispatcher;
  proxyResolved = true;
  const raw = config.GITHUB_PROXY ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    proxyDispatcher = new ProxyAgent(raw);
    logger.info({ proxy: `${parsed.protocol}//${parsed.host}` }, 'github oauth outbound proxy enabled');
  } catch (error) {
    logger.warn({ err: error }, 'github oauth proxy invalid, falling back to direct connection');
    proxyDispatcher = undefined;
  }
  return proxyDispatcher;
}

function causeOf(error: unknown): string {
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  if (cause?.code) return cause.code;
  if (cause?.message) return cause.message;
  return (error as { name?: string })?.name ?? 'unknown';
}

/** 本地假 provider / 回环地址不走代理，避免被出站代理拒连。 */
function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

/**
 * GitHub 出站请求统一出口：带代理、超时与一次重试。
 * 网络层失败单独抛 `github_unreachable`，不再和「GitHub 返回错误」混成一个兜底码。
 */
async function githubFetch(url: URL, init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: URLSearchParams }): Promise<OutboundResponse> {
  const dispatcher = isLoopback(url.hostname) ? undefined : outboundDispatcher();
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= OUTBOUND_ATTEMPTS; attempt += 1) {
    try {
      const res = await undiciFetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
        dispatcher,
      });
      return res as unknown as OutboundResponse;
    } catch (error) {
      lastError = error;
      if (attempt < OUTBOUND_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, OUTBOUND_RETRY_DELAY_MS));
      }
    }
  }
  throw new GithubOAuthError(
    'github_unreachable',
    `github unreachable (${causeOf(lastError)}${dispatcher ? ', via proxy' : ', direct'})`,
  );
}

/** 用授权码换 access token；GitHub 侧错误按可读语义映射。 */
export async function exchangeCode(input: { code: string; redirectUri: string; verifier: string }): Promise<string> {
  if (!config.GITHUB_CLIENT_ID || !config.GITHUB_CLIENT_SECRET) {
    throw new GithubOAuthError('not_configured');
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
  if (!res.ok) throw new GithubOAuthError('github_error', `github token endpoint ${res.status}`);
  const data = (await res.json().catch(() => null)) as TokenPayload | null;
  if (!data) throw new GithubOAuthError('github_error', 'github token response is not json');
  if (data.error) {
    const code: GithubOAuthErrorCode = data.error === 'bad_verification_code' ? 'code_expired' : 'github_error';
    throw new GithubOAuthError(code, data.error_description ?? data.error);
  }
  if (!data.access_token) throw new GithubOAuthError('github_error', 'missing access_token');
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
  if (!res.ok) throw new GithubOAuthError('github_error', `github api ${path} ${res.status}`);
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
    throw new GithubOAuthError('github_error', 'github user payload incomplete');
  }
  const verified = (Array.isArray(emails) ? emails : []).find((item) => item.primary && item.verified)
    ?? (Array.isArray(emails) ? emails : []).find((item) => item.verified);
  if (!verified?.email) throw new GithubOAuthError('email_unverified');

  return {
    id: String(user.id),
    login: user.login,
    name: user.name ?? null,
    avatarUrl: user.avatar_url ?? null,
    email: verified.email.trim().toLowerCase(),
  };
}

/** 失败统一回登录页，带错误码和可重试的站内落点。 */
export function loginErrorRedirect(code: GithubOAuthErrorCode, next: string | null): string {
  const params = new URLSearchParams({ oauthError: code });
  const safe = safeReturnTo(next);
  if (safe) params.set('next', safe);
  return `/login?${params.toString()}`;
}

/** 失败跳转也落在前端来源上，开发环境不会 404 在 API 端口。 */
export function loginErrorUrl(req: Request, code: GithubOAuthErrorCode, next: string | null): string {
  return webAppUrl(req, loginErrorRedirect(code, next));
}
