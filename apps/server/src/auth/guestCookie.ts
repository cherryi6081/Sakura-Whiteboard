import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import { config } from '../config.js';

/**
 * 游客身份 cookie `wb_gid`（开发文档 §4.5.1）。
 *
 * - 值格式：`v1.<guestId>.<exp>.<sig>`，`exp` 是 Unix 秒，`sig` 为 base64url。
 * - 签名：`HMAC-SHA256(key = GUEST_COOKIE_SECRET, msg = "v1|" + guestId + "|" + exp)`。
 * - 校验用 `timingSafeEqual` 做定长比较；签名错/过期/格式错一律静默当作无身份。
 * - `guestId` **只由服务端生成**，任何请求的 query/body/header 都不参与。
 */

export const GUEST_COOKIE = 'wb_gid';
export const GUEST_TTL_SECONDS = 30 * 24 * 60 * 60;
/** 剩余有效期少于该值时滚动续期（每天最多续一次） */
export const GUEST_RENEW_AFTER_SECONDS = 24 * 60 * 60;
const VERSION = 'v1';
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export type GuestCookieState = { guestId: string; exp: number };

export function generateGuestId(): string {
  const bytes = randomBytes(22);
  let body = '';
  for (const byte of bytes) body += BASE62[byte % 62];
  return `g_${body}`;
}

function sign(guestId: string, exp: number, key: string): string {
  return createHmac('sha256', key).update(`${VERSION}|${guestId}|${exp}`).digest('base64url');
}

/** 生成 cookie 值。`key` 参数仅供单测注入，业务代码不要传。 */
export function buildGuestCookieValue(guestId: string, exp: number, key = config.GUEST_COOKIE_SECRET): string {
  return `${VERSION}.${guestId}.${exp}.${sign(guestId, exp, key)}`;
}

function signatureMatches(expected: string, actual: string): boolean {
  let expectedBuf: Buffer;
  let actualBuf: Buffer;
  try {
    expectedBuf = Buffer.from(expected, 'base64url');
    actualBuf = Buffer.from(actual, 'base64url');
  } catch {
    return false;
  }
  if (expectedBuf.length !== actualBuf.length || expectedBuf.length === 0) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

export type VerifyResult = GuestCookieState;

/**
 * 验签。返回 `null` 表示"没有合法游客身份"（调用方应静默重新签发，不返回错误）。
 * `nowMs` / `keys` 参数供单测注入。
 */
export function verifyGuestCookieValue(
  raw: string | undefined | null,
  nowMs: number = Date.now(),
  keys: readonly string[] = [config.GUEST_COOKIE_SECRET, config.GUEST_COOKIE_SECRET_PREV].filter(
    (key): key is string => Boolean(key),
  ),
): VerifyResult | null {
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length !== 4) return null;
  const [version, guestId, expRaw, sig] = parts as [string, string, string, string];
  if (version !== VERSION) return null;
  if (!/^g_[A-Za-z0-9]{22}$/.test(guestId)) return null;
  if (!/^\d{1,12}$/.test(expRaw)) return null;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp <= Math.floor(nowMs / 1000)) return null;

  for (const key of keys) {
    if (signatureMatches(sign(guestId, exp, key), sig)) return { guestId, exp };
  }
  return null;
}

export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const jar: Record<string, string> = {};
  if (!header) return jar;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    try {
      jar[name] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      jar[name] = part.slice(index + 1).trim();
    }
  }
  return jar;
}

const secureAttribute = () => (config.NODE_ENV === 'production' ? '; Secure' : '');

export function serializeGuestCookie(value: string, maxAgeSeconds = GUEST_TTL_SECONDS): string {
  return `${GUEST_COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly${secureAttribute()}; SameSite=Lax`;
}

/** 判断是否需要滚动续期（剩余 < 1 天，或已过期）。 */
export function needsGuestRenewal(exp: number, nowMs: number = Date.now()): boolean {
  return exp - Math.floor(nowMs / 1000) < GUEST_RENEW_AFTER_SECONDS;
}

/** 给响应下发一个新的游客 cookie，返回 guestId。 */
export function issueGuestCookie(res: Response, guestId: string = generateGuestId(), nowMs: number = Date.now()): string {
  const exp = Math.floor(nowMs / 1000) + GUEST_TTL_SECONDS;
  res.append('Set-Cookie', serializeGuestCookie(buildGuestCookieValue(guestId, exp)));
  return guestId;
}

/** 合法且临近过期时滚动续期；否则不动。 */
export function maybeRenewGuestCookie(res: Response, state: GuestCookieState, nowMs: number = Date.now()): void {
  if (!needsGuestRenewal(state.exp, nowMs)) return;
  const exp = Math.floor(nowMs / 1000) + GUEST_TTL_SECONDS;
  res.append('Set-Cookie', serializeGuestCookie(buildGuestCookieValue(state.guestId, exp)));
}

/** 认领成功后清除游客身份（§8.6.3：服务端下发删除 `wb_gid`）。 */
export function clearGuestCookie(res: Response): void {
  res.append('Set-Cookie', `${GUEST_COOKIE}=; Path=/; Max-Age=0; HttpOnly${secureAttribute()}; SameSite=Lax`);
}
