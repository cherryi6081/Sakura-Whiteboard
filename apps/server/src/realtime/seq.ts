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

/**
 * 一次取一段连续序号：`{1, INCRBY 结果}`；键不存在时返回 `{0, 0}` 交给调用方播种，
 * 避免每批都去数据库读 `boards.last_seq`。
 */
const TAKE_SEQ_RANGE_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {0, 0} end
return {1, redis.call('INCRBY', KEYS[1], tonumber(ARGV[1]))}
`;

/** 键仍不存在时用 `seed`（来自 `boards.last_seq`）初始化，再原子取号段。 */
const SEED_AND_TAKE_SEQ_RANGE_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  redis.call('SET', KEYS[1], ARGV[1])
end
return {1, redis.call('INCRBY', KEYS[1], tonumber(ARGV[2]))}
`;

/**
 * 为一批 op 取连续序号，返回**第一个**序号（批内依次 +1）。
 *
 * 稳态只要一次 Redis 往返；只有 `seq:` 键缺失（首次使用 / Redis 重建）时才调用
 * `seed()` 去读 `boards.last_seq`，与旧的逐 op 播种语义一致。
 */
export async function allocateSeqRange(boardId: string, count: number, seed: () => Promise<number>): Promise<number> {
  if (count <= 0) throw new Error('allocateSeqRange: count must be positive');
  await ensureConnected();

  const taken = (await redis.eval(TAKE_SEQ_RANGE_LUA, 1, seqKey(boardId), String(count))) as [number, number];
  let end = Number(taken[1]);

  if (Number(taken[0]) === 0) {
    const seedValue = Math.max(0, Math.trunc(await seed()));
    const seeded = (await redis.eval(
      SEED_AND_TAKE_SEQ_RANGE_LUA,
      1,
      seqKey(boardId),
      String(seedValue),
      String(count),
    )) as [number, number];
    end = Number(seeded[1]);
  }

  return end - count + 1;
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

function parseIdemValue(value: string): IdemClaim {
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

/**
 * 批量占位：一次 pipeline 往返完成整批 `claim`，返回顺序与 `opIds` 一致。
 * 单条命令失败返回 `null`（调用方按 INTERNAL 拒绝，不释放——避免误删别人的 `done` 标记）。
 */
export async function claimOpIdemMany(boardId: string, opIds: string[]): Promise<(IdemClaim | null)[]> {
  if (opIds.length === 0) return [];
  await ensureConnected();

  const pipe = redis.pipeline();
  for (const opId of opIds) pipe.eval(CLAIM_IDEM_LUA, 1, idemKey(boardId, opId), String(IDEM_TTL_MS));
  const replies = await pipe.exec();
  if (!replies) throw new Error('claim idem pipeline failed');

  return replies.map(([err, raw]) => (err ? null : parseIdemValue(String(raw))));
}

/** 把整批占位从 `pending` 改写为最终的 seq，保留 120s 让重试拿到同一个序号。 */
export async function markOpIdemDoneMany(boardId: string, entries: Array<{ opId: string; seq: number }>): Promise<void> {
  if (entries.length === 0) return;
  await ensureConnected();

  const pipe = redis.pipeline();
  for (const { opId, seq } of entries) {
    pipe.set(idemKey(boardId, opId), JSON.stringify({ seq }), 'PX', IDEM_TTL_MS);
  }
  const replies = await pipe.exec();
  if (!replies) throw new Error('mark idem done pipeline failed');

  const failed = replies.find(([err]) => err !== null);
  if (failed?.[0]) throw failed[0];
}

/** 落库失败时释放占位，避免客户端在 TTL 内被误判为"处理中"。 */
export async function releaseOpIdemMany(boardId: string, opIds: string[]): Promise<void> {
  if (opIds.length === 0) return;
  await ensureConnected();

  const pipe = redis.pipeline();
  for (const opId of opIds) pipe.del(idemKey(boardId, opId));
  await pipe.exec();
}
