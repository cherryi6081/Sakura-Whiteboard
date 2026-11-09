import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * 资产签名 URL 的单测。config 在模块加载时解析 env，因此先 stub 再动态 import。
 */

const KEY = 'test-asset-url-secret-0123456789abcdef';
const ASSET = '6f1b9a52-0c34-4d9e-9b7e-6d64a5c1b3f2';
const NOW = 1_760_000_000_000;

let assetUrl: typeof import('./assetUrl.js');

beforeAll(async () => {
  vi.stubEnv('DATABASE_URL', 'postgres://u:p@127.0.0.1:5432/db');
  vi.stubEnv('REDIS_URL', 'redis://127.0.0.1:6379');
  vi.stubEnv('SESSION_SECRET', 'unit-test-session-secret');
  vi.stubEnv('GUEST_COOKIE_SECRET', 'unit-test-guest-secret-0123456789abcdef');
  assetUrl = await import('./assetUrl.js');
});

describe('assetUrl 签名', () => {
  it('正确签名可通过校验', () => {
    const exp = Math.floor(NOW / 1000) + 900;
    const sig = assetUrl.signAssetAccess(ASSET, exp, KEY);
    expect(assetUrl.verifyAssetAccess(ASSET, String(exp), sig, NOW, KEY)).toBe(true);
  });

  it('篡改 assetId / exp / sig 均失败', () => {
    const exp = Math.floor(NOW / 1000) + 900;
    const sig = assetUrl.signAssetAccess(ASSET, exp, KEY);
    expect(assetUrl.verifyAssetAccess('other-asset-id', String(exp), sig, NOW, KEY)).toBe(false);
    expect(assetUrl.verifyAssetAccess(ASSET, String(exp + 60), sig, NOW, KEY)).toBe(false);
    const flipped = `${sig.slice(0, 10)}${sig[10] === 'A' ? 'B' : 'A'}${sig.slice(11)}`;
    expect(assetUrl.verifyAssetAccess(ASSET, String(exp), flipped, NOW, KEY)).toBe(false);
    expect(assetUrl.verifyAssetAccess(ASSET, String(exp), sig, NOW, 'another-secret-0123456789abcdefghijkl')).toBe(false);
  });

  it('过期签名失效', () => {
    const exp = Math.floor(NOW / 1000) - 1;
    expect(assetUrl.verifyAssetAccess(ASSET, String(exp), assetUrl.signAssetAccess(ASSET, exp, KEY), NOW, KEY)).toBe(false);
  });

  it('格式非法的输入直接失败', () => {
    expect(assetUrl.verifyAssetAccess(ASSET, null, null, NOW, KEY)).toBe(false);
    expect(assetUrl.verifyAssetAccess(ASSET, 'abc', 'sig', NOW, KEY)).toBe(false);
    expect(assetUrl.verifyAssetAccess(ASSET, '123', '', NOW, KEY)).toBe(false);
  });
});
