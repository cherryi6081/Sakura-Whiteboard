import { pool } from '../infra/db.js';
import { ensureRedisConnected, redis } from '../infra/redis.js';
import { logger } from '../infra/logger.js';
import {
  FLUSH_BATCH_MAX,
  FLUSH_INTERVAL_MS,
  flushDirtyBoards,
  type DirtyBoardStore,
  type DirtyEntry,
} from './dirtyFlushCore.js';

/**
 * `boards.last_edited_at` 回写。
 *
 * op 落库本身不碰 `boards` 的编辑时间（避免每条 op 都打一次库）。这里用 Redis
 * 的 `dirty:boards` 有序集合做「短窗口合并」：
 *
 * - 写入：每次 `op:submit` 批次成功后，把 boardId 以 **Redis 时间** 为分数 `ZADD`
 *   进去；同一块板连续编辑只会不断刷新分数，不会产生多行；
 * - 读取：每 5s 用 Lua 原子地取出「分数早于窗口」的最多 200 块板并 `ZREM`，
 *   一次 `UPDATE ... FROM unnest(...)` 批量写回；
 * - 多副本：`ZRANGEBYSCORE + ZREM` 在同一段 Lua 里原子执行，同一块板同一窗口
 *   只会被一个副本领走，不会重复写；某个副本领走后崩溃，未写回的那几块板最多
 *   丢失一次刷新（下一次编辑会重新入队），换来的是一条 UPDATE/5s，而不是每 op 一次；
 * - 落库失败：按原分数重新入队（`ZADD ... GT`，只增不减，不会覆盖排队期间的新编辑）。
 *
 * 时间取值统一用 Redis `TIME`，避免多副本本机时钟偏差把「新编辑」判成旧记录。
 */

export const DIRTY_BOARDS_KEY = 'dirty:boards';

const MARK_LUA = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZADD', KEYS[1], now, ARGV[1])
return now
`;

/** 原子领取：返回 [id1, score1, id2, score2, ...]，并把它们从集合移除。 */
const CLAIM_LUA = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local cutoff = now - tonumber(ARGV[1])
local items = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', cutoff, 'WITHSCORES', 'LIMIT', 0, ARGV[2])
if #items == 0 then return {} end
for i = 1, #items, 2 do
  redis.call('ZREM', KEYS[1], items[i])
end
return items
`;

/** 标记一块板「有未回写的编辑」。失败只告警，不影响 op 主流程。 */
export async function markBoardEdited(boardId: string): Promise<void> {
  try {
    await ensureRedisConnected();
    await redis.eval(MARK_LUA, 1, DIRTY_BOARDS_KEY, boardId);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), boardId },
      'mark board edited failed',
    );
  }
}

export const redisDirtyStore: DirtyBoardStore = {
  async claim(windowMs, limit) {
    await ensureRedisConnected();
    const raw = await redis.eval(
      CLAIM_LUA,
      1,
      DIRTY_BOARDS_KEY,
      String(windowMs),
      String(limit),
    );
    if (!Array.isArray(raw)) return [];
    const entries: DirtyEntry[] = [];
    for (let i = 0; i + 1 < raw.length; i += 2) {
      entries.push({ id: String(raw[i]), atMs: Number(raw[i + 1]) });
    }
    return entries;
  },

  async requeue(entries) {
    if (entries.length === 0) return;
    await ensureRedisConnected();
    // GT：排队期间如果又有新编辑（分数更大），保留新值
    for (const entry of entries) {
      await redis.zadd(DIRTY_BOARDS_KEY, 'GT', entry.atMs, entry.id);
    }
  },
};

/** 批量写回；一块板一行，`greatest` 保证时间不回退。 */
export async function touchBoards(entries: DirtyEntry[]): Promise<number> {
  if (entries.length === 0) return 0;
  const { rowCount } = await pool.query(
    `update boards b
        set last_edited_at = greatest(b.last_edited_at, v.at)
       from unnest($1::text[], $2::timestamptz[]) as v(id, at)
      where b.id = v.id
        and b.deleted_at is null`,
    [entries.map((entry) => entry.id), entries.map((entry) => new Date(entry.atMs))],
  );
  return rowCount ?? 0;
}

/** 每 5s 跑一轮；启动时先跑一轮，排空上次进程退出时留下的标记。 */
export function startLastEditedFlush(): () => void {
  let stopped = false;
  let running = false;

  const tick = () => {
    if (stopped || running) return;
    running = true;
    void flushDirtyBoards(redisDirtyStore, touchBoards)
      .then((touched) => {
        if (touched > 0) logger.info({ boards: touched }, 'last edited flushed');
      })
      .catch((err: unknown) => {
        logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          'last edited flush failed',
        );
      })
      .finally(() => {
        running = false;
      });
  };

  tick();
  const timer = setInterval(tick, FLUSH_INTERVAL_MS);
  timer.unref?.();
  logger.info({ intervalMs: FLUSH_INTERVAL_MS, batchMax: FLUSH_BATCH_MAX }, 'last edited flush scheduled');

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
