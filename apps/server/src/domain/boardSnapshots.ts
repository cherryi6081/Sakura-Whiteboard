import { pool } from '../infra/db.js';
import { logger } from '../infra/logger.js';

/** 每累计这么多条 op 落一份快照；与客户端 resyncThreshold（500）错开一个量级 */
export const SNAPSHOT_OP_INTERVAL = 100;
/** 每块板保留最近几份（迁移 0001 的约定） */
export const SNAPSHOT_KEEP = 5;

export type BoardSnapshot = {
  seq: number;
  elements: Record<string, unknown>[];
};

type ElementRow = {
  element_id: string;
  version: string;
  version_nonce: string;
  data: Record<string, unknown>;
};

/** 同一块板在同一实例内只允许一个快照任务在跑，避免并发写同一份 state */
const inFlight = new Set<string>();

/**
 * 写一份当前状态的快照。
 *
 * 先读 `boards.last_seq` 再读元素：元素表只会被更新的 op 覆盖，因此快照里最多多出几条
 * `seq` 之后的改动，客户端按 seq 补拉时会用 LWW 重放，结果一致；
 * 反过来先读元素再读水位，才可能出现"缺 op"的错误快照。
 */
export async function takeSnapshot(boardId: string): Promise<number | null> {
  if (inFlight.has(boardId)) return null;
  inFlight.add(boardId);
  try {
    const { rows: boardRows } = await pool.query<{ last_seq: string }>(
      'select last_seq from boards where id = $1',
      [boardId],
    );
    const seq = Number(boardRows[0]?.last_seq ?? 0);
    if (seq <= 0) return null;

    const { rows } = await pool.query<ElementRow>(
      `select element_id, version, version_nonce, data
         from elements
        where board_id = $1 and is_deleted = false
        order by zindex_key asc, element_id asc`,
      [boardId],
    );
    const elements = rows.map((row) => ({
      ...row.data,
      id: row.element_id,
      version: Number(row.version),
      versionNonce: Number(row.version_nonce),
      isDeleted: false,
    }));

    await pool.query(
      `insert into board_snapshots (board_id, seq, state)
       values ($1, $2, $3::jsonb)
       on conflict (board_id, seq) do nothing`,
      [boardId, seq, JSON.stringify({ elements })],
    );
    // 只留最近 SNAPSHOT_KEEP 份：老的压缩点没有补拉价值，留着只会拖慢 max(seq) 查询
    await pool.query(
      `delete from board_snapshots
        where board_id = $1
          and seq not in (
            select seq from board_snapshots where board_id = $1 order by seq desc limit $2
          )`,
      [boardId, SNAPSHOT_KEEP],
    );
    return seq;
  } finally {
    inFlight.delete(boardId);
  }
}

/** 累计 op 数达到间隔才落快照；差值同时覆盖多实例各自的批量提交 */
export async function maybeSnapshotBoard(boardId: string, lastSeq: number): Promise<void> {
  const { rows } = await pool.query<{ seq: string }>(
    'select coalesce(max(seq), 0) as seq from board_snapshots where board_id = $1',
    [boardId],
  );
  if (lastSeq - Number(rows[0]?.seq ?? 0) < SNAPSHOT_OP_INTERVAL) return;
  await takeSnapshot(boardId);
}

/** 读最新快照；没有返回 null，由调用方回退到现算。 */
export async function latestSnapshot(boardId: string): Promise<BoardSnapshot | null> {
  const { rows } = await pool.query<{ seq: string; state: { elements?: Record<string, unknown>[] } }>(
    'select seq, state from board_snapshots where board_id = $1 order by seq desc limit 1',
    [boardId],
  );
  const row = rows[0];
  if (!row) return null;
  return { seq: Number(row.seq), elements: Array.isArray(row.state?.elements) ? row.state.elements : [] };
}

/** 快照写入失败只影响读路径的性能，不能把写 op 的主链路带崩。 */
export function scheduleSnapshot(boardId: string, lastSeq: number): void {
  void maybeSnapshotBoard(boardId, lastSeq).catch((err: unknown) => {
    logger.warn({ boardId, err: err instanceof Error ? err.message : String(err) }, 'snapshot failed');
  });
}
