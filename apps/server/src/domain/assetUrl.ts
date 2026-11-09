import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

/**
 * 资产签名 URL（§4.6 第二章第 4/6 条）。
 *
 * 读取图片**不走身份校验**，而是走短时签名：URL 带 `exp` 与 `sig`，
 * 因此 `<img src>` 这种不带自定义头的加载方式也能用；权限判定发生在签发 URL 的
 * `GET /api/assets/:id/url`（那里会走 `resolveBoardAccess`）。
 * 签名覆盖 `assetId + exp`，改任何一个字节都会失效，不能靠"猜不到的 URL"当权限。
 */

const SECRET = () => config.ASSET_URL_SECRET ?? config.SESSION_SECRET;

function sign(assetId: string, exp: number, key: string): string {
  return createHmac('sha256', key).update(`v1|${assetId}|${exp}`).digest('base64url');
}

export function signAssetAccess(assetId: string, exp: number, key = SECRET()): string {
  return sign(assetId, exp, key);
}

/** 校验 `exp` 未过期且签名一致（`nowMs` / `key` 供单测注入）。 */
export function verifyAssetAccess(
  assetId: string,
  expRaw: string | null | undefined,
  sig: string | null | undefined,
  nowMs: number = Date.now(),
  key = SECRET(),
): boolean {
  if (!expRaw || !sig || !/^\d{1,12}$/.test(expRaw)) return false;
  const exp = Number(expRaw);
  if (exp <= Math.floor(nowMs / 1000)) return false;

  const expected = Buffer.from(sign(assetId, exp, key), 'base64url');
  const actual = Buffer.from(sig, 'base64url');
  if (expected.length === 0 || expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/** 生成带 `exp`/`sig` 的站内相对路径（前端直接给 `<img src>` 用）。 */
export function assetRawPath(assetId: string, nowMs: number = Date.now()): { path: string; expiresAt: Date } {
  const exp = Math.floor(nowMs / 1000) + config.ASSET_URL_TTL_SECONDS;
  return {
    path: `/api/assets/${assetId}/raw?exp=${exp}&sig=${sign(assetId, exp, SECRET())}`,
    expiresAt: new Date(exp * 1000),
  };
}
