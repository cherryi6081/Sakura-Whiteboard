import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import { config } from '../config.js';
import { ensureRedisConnected, redis } from '../infra/redis.js';

/**
 * 会话（开发文档 §5）：Redis `sess:{sid}`，cookie 只带签名后的 sid。
 * - cookie 名 `wb_sess`，值 `v1.<sid>.<sig>`（HMAC-SHA256(SESSION_SECRET)）。
 * - TTL 7 天滚动：每次读取成功都续期。
 * - 登出删除 `sess:{sid}`；同一浏览器所有标签共用这一条 cookie，因此登出对所有标签生效。
 */

export const SESSION_COOKIE = 'wb_sess';
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const VERSION = 'v1';

export type SessionData = {
  userId: string;
  loginMethod: 'password' | 'oauth:github';
  createdAt: number;
  lastSeenAt: number;
};

function sign(sid: string): string {
  return createHmac('sha256', config.SESSION_SECRET).update(`${VERSION}|${sid}`).digest('base64url');
}

export function createSessionSid(): string {
  return randomBytes(24).toString('base64url');
}

export function buildSessionCookieValue(sid: string): string {
  return `${VERSION}.${sid}.${sign(sid)}`;
}

export function parseSessionCookieValue(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  const [version, sid, sig] = parts as [string, string, string];
  if (version !== VERSION || !/^[A-Za-z0-9_-]{16,64}$/.test(sid)) return null;
  let expected: Buffer;
  let actual: Buffer;
  try {
    expected = Buffer.from(sign(sid), 'base64url');
    actual = Buffer.from(sig, 'base64url');
  } catch {
    return null;
  }
  if (expected.length !== actual.length || expected.length === 0) return null;
  return timingSafeEqual(expected, actual) ? sid : null;
}

const secureAttribute = () => (config.NODE_ENV === 'production' ? '; Secure' : '');

export function serializeSessionCookie(sid: string, maxAgeSeconds = SESSION_TTL_SECONDS): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(buildSessionCookieValue(sid))}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly${secureAttribute()}; SameSite=Lax`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly${secureAttribute()}; SameSite=Lax`;
}

const sessionKey = (sid: string) => `sess:${sid}`;

export async function createSession(userId: string, loginMethod: SessionData['loginMethod'], res?: Response): Promise<string> {
  const sid = createSessionSid();
  const now = Date.now();
  const data: SessionData = { userId, loginMethod, createdAt: now, lastSeenAt: now };
  await ensureRedisConnected();
  await redis.set(sessionKey(sid), JSON.stringify(data), 'EX', SESSION_TTL_SECONDS);
  if (res) res.append('Set-Cookie', serializeSessionCookie(sid));
  return sid;
}

/** Redis 不可用时返回 null（等同于未登录），由调用方按游客处理。 */
export async function readSession(sid: string): Promise<SessionData | null> {
  try {
    await ensureRedisConnected();
    const raw = await redis.get(sessionKey(sid));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SessionData>;
    if (typeof parsed.userId !== 'string') return null;
    const data: SessionData = {
      userId: parsed.userId,
      loginMethod: parsed.loginMethod === 'oauth:github' ? 'oauth:github' : 'password',
      createdAt: Number(parsed.createdAt ?? 0),
      lastSeenAt: Date.now(),
    };
    // 滚动续期（失败不影响本次请求）
    await redis.set(sessionKey(sid), JSON.stringify(data), 'EX', SESSION_TTL_SECONDS).catch(() => undefined);
    return data;
  } catch {
    return null;
  }
}

export async function destroySession(sid: string): Promise<void> {
  try {
    await ensureRedisConnected();
    await redis.del(sessionKey(sid));
  } catch {
    /* Redis 不可用时无法即时吊销；cookie 仍会被清除 */
  }
}
