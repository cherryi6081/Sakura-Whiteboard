/**
 * `dirty:boards` 合并器的纯逻辑（不依赖 Redis / PG，便于单测）。
 *
 * 真正的 Redis 领取与 PostgreSQL 批量写回在 `lastEditedFlush.ts`。
 */

/** 合并窗口：同一块板 5s 内的多次编辑只写一次库 */
export const FLUSH_INTERVAL_MS = 5_000;
/** 单轮最多领走的板数，避免一次 UPDATE 过大 */
export const FLUSH_BATCH_MAX = 200;

export type DirtyEntry = {
  id: string;
  /** 最后一次编辑的 Redis 毫秒时间戳 */
  atMs: number;
};

export type DirtyBoardStore = {
  claim(windowMs: number, limit: number): Promise<DirtyEntry[]>;
  requeue(entries: DirtyEntry[]): Promise<void>;
};

/**
 * 领一批并写回。窗口内的多次编辑已在 Redis 端合并成一条记录，
 * 这里保证「一批只打一次库」；失败时按原分数重新入队。
 */
export async function flushDirtyBoards(
  store: DirtyBoardStore,
  touch: (entries: DirtyEntry[]) => Promise<number>,
): Promise<number> {
  const entries = await store.claim(FLUSH_INTERVAL_MS, FLUSH_BATCH_MAX);
  if (entries.length === 0) return 0;

  try {
    return await touch(entries);
  } catch (err) {
    await store.requeue(entries).catch(() => undefined);
    throw err;
  }
}
