import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * `wb_gid` 签名 cookie 的单元测试（开发文档 §4.5.1）。
 * config 在模块加载时解析 env，因此先 stub 再动态 import。
 */

const KEY = 'unit-test-guest-secret-0123456789abcdef';
const PREV = 'unit-test-guest-secret-prev-0123456789abc';

let guest: typeof import('./guestCookie.js');

beforeAll(async () => {
  vi.stubEnv('DATABASE_URL', 'postgres://u:p@127.0.0.1:5432/db');
  vi.stubEnv('REDIS_URL', 'redis://127.0.0.1:6379');
  vi.stubEnv('SESSION_SECRET', 'unit-test-session-secret');
  vi.stubEnv('GUEST_COOKIE_SECRET', KEY);
  vi.stubEnv('GUEST_COOKIE_SECRET_PREV', PREV);
  guest = await import('./guestCookie.js');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('wb_gid 签名 cookie', () => {
  it('生成的 guestId 形状固定且随机', () => {
    const a = guest.generateGuestId();
    const b = guest.generateGuestId();
    expect(a).toMatch(/^g_[A-Za-z0-9]{22}$/);
    expect(a).not.toBe(b);
  });

  it('签名后可验签，返回 guestId 与 exp', () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const value = guest.buildGuestCookieValue('g_0123456789abcdefghijkl', exp);
    const parsed = guest.verifyGuestCookieValue(value);
    expect(parsed).toEqual({ guestId: 'g_0123456789abcdefghijkl', exp });
    expect(value.split('.')).toHaveLength(4);
  });

  it('篡改 guestId 或签名一律拒绝', () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const value = guest.buildGuestCookieValue('g_0123456789abcdefghijkl', exp);
    const parts = value.split('.');

    const forgedGuest = [parts[0], 'g_zzzzzzzzzzzzzzzzzzzzzz', parts[2], parts[3]].join('.');
    expect(guest.verifyGuestCookieValue(forgedGuest)).toBeNull();

    const forgedSig = [parts[0], parts[1], parts[2], 'AAAA'].join('.');
    expect(guest.verifyGuestCookieValue(forgedSig)).toBeNull();

    expect(guest.verifyGuestCookieValue(value.slice(0, -2))).toBeNull();
  });

  it('过期值拒绝', () => {
    const exp = Math.floor(Date.now() / 1000) - 1;
    const value = guest.buildGuestCookieValue('g_0123456789abcdefghijkl', exp);
    expect(guest.verifyGuestCookieValue(value)).toBeNull();
  });

  it('轮换期用上一代密钥仍可验签，错密钥不行', () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const value = guest.buildGuestCookieValue('g_0123456789abcdefghijkl', exp, PREV);
    expect(guest.verifyGuestCookieValue(value)).toEqual({ guestId: 'g_0123456789abcdefghijkl', exp });
    expect(guest.verifyGuestCookieValue(value, Date.now(), ['another-key-0123456789abcdefghij'])).toBeNull();
  });

  it('非预期格式静默拒绝', () => {
    expect(guest.verifyGuestCookieValue(undefined)).toBeNull();
    expect(guest.verifyGuestCookieValue('')).toBeNull();
    expect(guest.verifyGuestCookieValue('v1.abc.123.sig.extra')).toBeNull();
    expect(guest.verifyGuestCookieValue('v2.g_0123456789abcdefghijkl.99.sig')).toBeNull();
  });

  it('Cookie 头解析与滚动续期阈值', () => {
    expect(guest.parseCookieHeader('a=1; wb_gid=x%2Ey; empty=')).toEqual({ a: '1', wb_gid: 'x.y', empty: '' });
    const now = Date.now();
    expect(guest.needsGuestRenewal(Math.floor(now / 1000) + guest.GUEST_TTL_SECONDS, now)).toBe(false);
    expect(guest.needsGuestRenewal(Math.floor(now / 1000) + 3600, now)).toBe(true);
  });
});
