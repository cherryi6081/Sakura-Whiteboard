import crypto from 'node:crypto';
import { pool } from '../infra/db.js';
import { ensureRedisConnected, redis } from '../infra/redis.js';

/**
 * 分享链接（M5-2，开发文档 §4.1 / §7.1.4）。
 *
 * - 明文 token 只在创建时返回一次；库里存 `sha256(token)`，泄露数据库也拿不到可用链接。
 * - 校验顺序：`share:{tokenHash}` 缓存命中 → 直接判定；未命中 → 查 `share_links` 并回填缓存。
 * - 吊销时**同步删除 `share:` 键**，下一次请求必然回落数据库，因此立即失效。
 * - `boards.share_mode` 只保留"该板是否开放链接分享"的历史语义，v1 的匿名访问一律要求 token。
 */

export type SharePermission = 'read' | 'edit';

type ShareRecord = {
  boardId: string;
  permission: SharePermission;
  /** epoch ms；null = 永久 */
  expiresAt: number | null;
  /** epoch ms；null = 未吊销 */
  revokedAt: number | null;
};

const SHARE_CACHE_TTL = 60; // 文档 §4.3：60s，吊销时主动删

const cacheKey = (tokenHash: string) => `share:${tokenHash}`;

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function randomBase62(length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += BASE62[crypto.randomInt(0, BASE62.length)];
  return out;
}

/** 32 字节随机 → `s_` + 43 位 base62（约 257 bit，足够抵抗枚举）。 */
export function generateShareToken(): string {
  return `s_${randomBase62(43)}`;
}

export function hashShareToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function writeShareCache(tokenHash: string, record: ShareRecord): Promise<void> {
  try {
    await ensureRedisConnected();
    await redis.set(cacheKey(tokenHash), JSON.stringify(record), 'EX', SHARE_CACHE_TTL);
  } catch {
    // 缓存不是权威来源；Redis 不可用时直接走数据库
  }
}

export async function invalidateShareCache(tokenHash: string): Promise<void> {
  try {
    await ensureRedisConnected();
    await redis.del(cacheKey(tokenHash));
  } catch (err) {
    console.warn('[share] 删除 share 缓存失败，将由 TTL 兜底', { err: err instanceof Error ? err.message : String(err) });
  }
}

const isUsable = (record: ShareRecord, boardId: string, nowMs: number): boolean =>
  record.boardId === boardId &&
  record.revokedAt === null &&
  (record.expiresAt === null || record.expiresAt > nowMs);

/**
 * 解析分享 token 的有效权限；任何失败（格式错/查无/过期/吊销/板不匹配）都返回 null。
 * 身份绝不来自客户端自报的 `permission` / `boardId`：boardId 由调用方传入的实际请求目标。
 */
export async function resolveShareToken(
  boardId: string,
  rawToken: string | null | undefined,
): Promise<SharePermission | null> {
  if (!rawToken || rawToken.length > 128) return null;
  const tokenHash = hashShareToken(rawToken);
  const nowMs = Date.now();

  try {
    await ensureRedisConnected();
    const cached = await redis.get(cacheKey(tokenHash));
    if (cached) {
      const record = JSON.parse(cached) as ShareRecord;
      if (isUsable(record, boardId, nowMs)) return record.permission;
      // 缓存里是过期/吊销记录：仍然回落数据库，避免"被删除后又被旧缓存命中"
      if (record.revokedAt !== null) return null;
    }
  } catch {
    // 忽略缓存故障，继续查库
  }

  const { rows } = await pool.query<{
    board_id: string;
    permission: SharePermission;
    expires_at: Date | null;
    revoked_at: Date | null;
  }>(
    'select board_id, permission, expires_at, revoked_at from share_links where token_hash = $1',
    [tokenHash],
  );
  const row = rows[0];
  if (!row) return null;

  const record: ShareRecord = {
    boardId: row.board_id,
    permission: row.permission,
    expiresAt: row.expires_at ? row.expires_at.getTime() : null,
    revokedAt: row.revoked_at ? row.revoked_at.getTime() : null,
  };
  if (!isUsable(record, boardId, nowMs)) {
    await writeShareCache(tokenHash, record);
    return null;
  }

  await writeShareCache(tokenHash, record);
  // 粗粒度审计：只统计真正拿到权限的访问
  void pool
    .query('update share_links set use_count = use_count + 1 where token_hash = $1', [tokenHash])
    .catch((err: unknown) => {
      console.warn('[share] use_count 自增失败', { err: err instanceof Error ? err.message : String(err) });
    });
  return record.permission;
}
