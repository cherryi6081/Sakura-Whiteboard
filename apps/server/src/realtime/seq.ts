/**
 * Redis 侧的两件事：`seq` 分配与 op 幂等占位。
 *
 * 键设计（与文档 §4.3 的写法对应）：
 * - `seq:${boardId}`        —— 严格单调递增的板内序号，`INCR` 分配；缺失时用 `boards.last_seq` 播种。
 * - `idem:${boardId}:${opId}` —— 幂等占位；`pending` 表示正在处理，完成后写成 `{"seq":n}`，保留 120s。
 *
 * 这里 **不使用任何内存 Map**：每次提交都真的走 Redis。
 */

import { redis } from '../infra/redis.js';

export const IDEM_TTL_MS = 120_000;

export function seqKey(boardId: string): string {
  return `seq:${boardId}`;
}

export function idemKey(boardId: string, opId: string): string {
  const hashTagSafeOpId = opId.replace(/[^A-Za-z0-9_-]/g, '_');
  return `idem:${boardId}:${hashTagSafeOpId}`;
}

async function ensureConnected(): Promise<void> {
  if (redis.status === 'ready') return;
  try {
    await redis.connect();
  } catch (err) {
    // 并发调用时可能已在连接中；只要不是"连接中/已连接"就向上抛
    if (!/already/i.test(String(err))) throw err;
  }
}

/** `exists` 不存在则用 `seed` 初始化，然后原子 `INCR`。缺失时由 `boards.last_seq` 重建。 */
const ALLOCATE_SEQ_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  redis.call('SET', KEYS[1], ARGV[1])
end
return redis.call('INCR', KEYS[1])
`;

export async function allocateSeq(boardId: string, seed: number): Promise<number> {
  await ensureConnected();
  const raw = await redis.eval(ALLOCATE_SEQ_LUA, 1, seqKey(boardId), String(Math.max(0, Math.trunc(seed))));
  return Number(raw);
}

export type IdemClaim =
  | { kind: 'claimed' }
  | { kind: 'in-flight' }
  | { kind: 'done'; seq: number };

/** 原子占位：已有记录直接返回，没有则写入 `pending`。 */
const CLAIM_IDEM_LUA = `
local current = redis.call('GET', KEYS[1])
if current then return current end
redis.call('SET', KEYS[1], 'pending', 'PX', ARGV[1])
return 'pending'
`;

export async function claimOpIdem(boardId: string, opId: string): Promise<IdemClaim> {
  await ensureConnected();
  const raw = await redis.eval(CLAIM_IDEM_LUA, 1, idemKey(boardId, opId), String(IDEM_TTL_MS));
  const value = String(raw);

  if (value === 'pending') return { kind: 'claimed' };

  if (value.startsWith('pending:')) return { kind: 'in-flight' };

  try {
    const parsed = JSON.parse(value) as { seq?: unknown };
    if (typeof parsed.seq === 'number' && Number.isFinite(parsed.seq)) {
      return { kind: 'done', seq: parsed.seq };
    }
  } catch {
    // 落到 in-flight：宁可让客户端重试，也不能把坏值当成功
  }
  return { kind: 'in-flight' };
}

/** 把占位从 `pending` 改写为最终的 seq，保留 120s 让重试拿到同一个序号。 */
export async function markOpIdemDone(boardId: string, opId: string, seq: number): Promise<void> {
  await ensureConnected();
  await redis.set(idemKey(boardId, opId), JSON.stringify({ seq }), 'PX', IDEM_TTL_MS);
}

/** 落库失败时释放占位，避免客户端在 TTL 内被误判为"处理中"。 */
export async function releaseOpIdem(boardId: string, opId: string): Promise<void> {
  await ensureConnected();
  await redis.del(idemKey(boardId, opId));
}
