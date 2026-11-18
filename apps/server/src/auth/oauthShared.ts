import { createHash, randomBytes } from 'node:crypto';
import type { Request } from 'express';
import { fetch as undiciFetch, ProxyAgent } from 'undici';
import { config } from '../config.js';
import { logger } from '../infra/logger.js';
import { ensureRedisConnected, redis } from '../infra/redis.js';

/**
 * 第三方登录的公共部分：state、PKCE、回跳地址与带代理的出站请求。
 *
 * GitHub 与 Google 共用同一套口径，只在 provider 维度上分开：
 * - state 落 Redis 时带 provider 前缀，互不干扰；
 * - state cookie 每个 provider 各一条（同名 cookie 不同 Path 会同时被发送，分开更稳）；
 * - 回跳地址与错误码格式保持一致，前端只需要按 provider 换文案。
 */

export type OAuthProvider = 'github' | 'google';
export type OAuthStateMode = 'login' | 'bind';

export type OAuthStateRecord = {
  returnTo: string;
  codeVerifier: string;
  createdAt: number;
  /** 默认 login；bind 表示已登录用户正在绑定该 provider。 */
  mode?: OAuthStateMode;
  /** bind 模式下发起流程的用户；回调必须与当前会话一致。 */
  userId?: string;
};

// 真实联调发现：登录 + 2FA 常超过 10 分钟，联调时 16 分钟才回调导致 state 过期，放宽到 20 分钟
export const STATE_TTL_SECONDS = 1200;

const STATE_KEY = (provider: OAuthProvider, state: string) => `oauth:${provider}:state:${state}`;

/**
 * state 值本身带模式前缀：`b~` 为绑定流程。
 * `~` 不在 base64url 字符集里，不会与普通登录 state 混淆；
 * 这样即使 Redis 里的 state 已过期，回调也能把用户送回账号设置而不是登录页。
 */
const BIND_STATE_PREFIX = 'b~';

export function createState(mode: OAuthStateMode = 'login'): string {
  const random = randomBytes(24).toString('base64url');
  return mode === 'bind' ? `${BIND_STATE_PREFIX}${random}` : random;
}

export function isBindState(state: string): boolean {
  return state.startsWith(BIND_STATE_PREFIX);
}

export async function saveState(
  provider: OAuthProvider,
  state: string,
  record: OAuthStateRecord,
): Promise<void> {
  await ensureRedisConnected();
  await redis.set(STATE_KEY(provider, state), JSON.stringify(record), 'EX', STATE_TTL_SECONDS);
}

/** 一次性消费：读到即删，同一 state 无法二次回调。 */
export async function consumeState(
  provider: OAuthProvider,
  state: string,
): Promise<OAuthStateRecord | null> {
  await ensureRedisConnected();
  const raw = await redis.getdel(STATE_KEY(provider, state));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<OAuthStateRecord>;
    if (typeof parsed.returnTo !== 'string' || typeof parsed.codeVerifier !== 'string') return null;
    return {
      returnTo: safeReturnTo(parsed.returnTo) ?? '/',
      codeVerifier: parsed.codeVerifier,
      createdAt: Number(parsed.createdAt ?? 0),
      mode: parsed.mode === 'bind' ? 'bind' : 'login',
      userId: typeof parsed.userId === 'string' ? parsed.userId : undefined,
    };
  } catch {
    return null;
  }
}

/** 只允许站内绝对路径，挡住 `//evil.com`、反斜杠与控制字符。 */
export function safeReturnTo(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return null;
  if (/[\u0000-\u001f]/.test(raw)) return null;
  return raw;
}

export function requestOrigin(req: Request): string {
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

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** state cookie 的差异只有名称与 Path：GitHub 与 Google 各一条，互不覆盖。 */
export type OAuthStateCookie = { name: string; path: string };

/**
 * state cookie 允许并存多个值（点号分隔，base64url 不含点）。
 *
 * 用户连点两次「使用 GitHub 登录」会先后开两条授权流程：若 cookie 只存最后一个 state，
 * 先回来的那条必然 state_mismatch。这里保留最近若干个候选，回调命中任意一个即可。
 */
const STATE_COOKIE_MAX = 5;

export function buildStateCookie(cookie: OAuthStateCookie, states: string[]): string {
  const secure = config.NODE_ENV === 'production' ? '; Secure' : '';
  const value = states.filter(Boolean).slice(-STATE_COOKIE_MAX).join('.');
  return `${cookie.name}=${value}; Path=${cookie.path}; Max-Age=${STATE_TTL_SECONDS}; HttpOnly${secure}; SameSite=Lax`;
}

export function parseStateCookieValue(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split('.')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(-STATE_COOKIE_MAX);
}

export function clearStateCookie(cookie: OAuthStateCookie): string {
  const secure = config.NODE_ENV === 'production' ? '; Secure' : '';
  return `${cookie.name}=; Path=${cookie.path}; Max-Age=0; HttpOnly${secure}; SameSite=Lax`;
}

export type OAuthErrorCode =
  | 'not_configured'
  | 'state_mismatch'
  | 'state_expired'
  | 'code_expired'
  | 'email_unverified'
  | 'account_disabled'
  | 'access_denied'
  | 'github_unreachable'
  | 'google_unreachable'
  | 'temporarily_unavailable'
  | 'github_error'
  | 'google_error';

/** 第三方登录失败：只带语义化错误码，不把第三方原文透给前端。 */
export class OAuthError extends Error {
  constructor(
    public readonly code: OAuthErrorCode,
    message: string = code,
  ) {
    super(message);
  }
}

export type OutboundResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

const OUTBOUND_TIMEOUT_MS = 15_000;
const OUTBOUND_ATTEMPTS = 2;
const OUTBOUND_RETRY_DELAY_MS = 300;

/** 本地假 provider / 回环地址不走代理，避免被出站代理拒连。 */
function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function causeOf(error: unknown): string {
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  if (cause?.code) return cause.code;
  if (cause?.message) return cause.message;
  return (error as { name?: string })?.name ?? 'unknown';
}

/**
 * 出站请求统一出口：带代理、超时与一次重试。
 *
 * Node 自带 fetch **不读系统代理**（浏览器走的代理它拿不到），开发机上直连 github.com /
 * accounts.google.com 容易被网络层超时，于是换 token 失败。这里按配置显式注入代理：
 * provider 专属变量优先，其次标准 `HTTPS_PROXY` / `HTTP_PROXY`，都没有才直连。
 */
export function createOutboundFetch(options: {
  proxyUrl: string | undefined;
  label: string;
  unreachableCode: OAuthErrorCode;
}) {
  let dispatcher: ProxyAgent | undefined;
  let proxyResolved = false;

  const resolveDispatcher = (): ProxyAgent | undefined => {
    if (proxyResolved) return dispatcher;
    proxyResolved = true;
    const raw = options.proxyUrl ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
    if (!raw) return undefined;
    try {
      const parsed = new URL(raw);
      dispatcher = new ProxyAgent(raw);
      logger.info({ proxy: `${parsed.protocol}//${parsed.host}` }, `${options.label} oauth outbound proxy enabled`);
    } catch (error) {
      logger.warn({ err: error }, `${options.label} oauth proxy invalid, falling back to direct connection`);
      dispatcher = undefined;
    }
    return dispatcher;
  };

  return async function outbound(
    url: URL,
    init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: URLSearchParams },
  ): Promise<OutboundResponse> {
    const dispatcher = isLoopback(url.hostname) ? undefined : resolveDispatcher();
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
    throw new OAuthError(
      options.unreachableCode,
      `${options.label} unreachable (${causeOf(lastError)}${dispatcher ? ', via proxy' : ', direct'})`,
    );
  };
}
