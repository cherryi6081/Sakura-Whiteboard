import type { ElementOp } from '@whiteboard/shared';
import { logger } from '../infra/logger.js';
import { markBoardEdited } from '../jobs/lastEditedFlush.js';
import { getBoardLastSeq, persistOps, type PersistOpResult } from './opStore.js';
import {
  allocateSeqRange,
  claimOpIdemMany,
  markOpIdemDoneMany,
  releaseOpIdemMany,
  type IdemClaim,
} from './seq.js';

/**
 * 同板写路径攒批。
 *
 * 每个 board 一条 FIFO 队列，同一时刻只有一个 flush 在跑，因此：
 * - 入队顺序 = seq 分配顺序 = 落库顺序，批内与跨批都不会乱序；
 * - N 条 op 合并成 1 个数据库事务、每个阶段 1 次 Redis 往返（`claim` / 取号段 / `done` 都是 pipeline）。
 *
 * 攒批窗口用 `setImmediate`（同一事件循环 tick）而不是定时器：Windows 上 `setTimeout(5)` 实测
 * 要 ~14ms 才触发，会给低负载的每条 ack 加一笔固定延迟；而高负载下真正的批量来自「flush 进行中
 * 新到的 op 留在队列里」，不依赖 tick 窗口。
 *
 * 失败时整批 `release` 幂等占位并回 `INTERNAL`（客户端会保留队列重试，语义与逐条失败一致）。
 */

/** 单个事务最多合并的 op 数（与客户端单批上限一致）。 */
const BATCH_MAX_OPS = 100;

export type SubmitInput = {
  boardId: string;
  clientId: string;
  userId: string | null;
  guestId: string | null;
  op: ElementOp;
};

export type SubmitOutcome =
  | { kind: 'persisted'; opId: string; seq: number; applied: boolean; stale: boolean }
  | { kind: 'duplicate'; opId: string; seq: number }
  | { kind: 'rejected'; opId: string; reason: 'IDEMPOTENT_IN_FLIGHT' | 'INTERNAL' };

type Pending = {
  input: SubmitInput;
  resolve: (outcome: SubmitOutcome) => void;
};

type QueueState = {
  boardId: string;
  items: Pending[];
  scheduled: NodeJS.Immediate | null;
  flushing: boolean;
};

export type WriteBatcher = {
  submit(input: SubmitInput): Promise<SubmitOutcome>;
};

export function createWriteBatcher(): WriteBatcher {
  const queues = new Map<string, QueueState>();

  const stateOf = (boardId: string): QueueState => {
    let state = queues.get(boardId);
    if (!state) {
      state = { boardId, items: [], scheduled: null, flushing: false };
      queues.set(boardId, state);
    }
    return state;
  };

  const drain = async (state: QueueState): Promise<void> => {
    if (state.flushing) return;
    state.flushing = true;

    try {
      while (state.items.length > 0) {
        const items = state.items.splice(0, BATCH_MAX_OPS);
        try {
          await flushOnce(state.boardId, items);
        } catch (err) {
          // 兜底：flushOnce 内部各阶段都已 catch，这里保证任何意外都不会留下未 resolve 的 Promise
          rejectAll(items, err);
        }
      }
    } finally {
      state.flushing = false;
      if (state.items.length > 0) void drain(state);
      else queues.delete(state.boardId);
    }
  };

  return {
    submit(input: SubmitInput): Promise<SubmitOutcome> {
      return new Promise<SubmitOutcome>((resolve) => {
        const state = stateOf(input.boardId);
        state.items.push({ input, resolve });

        if (state.flushing) return;

        if (state.items.length >= BATCH_MAX_OPS) {
          if (state.scheduled) {
            clearImmediate(state.scheduled);
            state.scheduled = null;
          }
          void drain(state);
          return;
        }

        if (!state.scheduled) {
          state.scheduled = setImmediate(() => {
            state.scheduled = null;
            void drain(state);
          });
        }
      });
    },
  };
}

function rejectAll(items: Pending[], err: unknown): void {
  logger.error(
    { err: err instanceof Error ? err.message : String(err), ops: items.length },
    'op batch failed',
  );
  for (const item of items) {
    item.resolve({ kind: 'rejected', opId: item.input.op.opId, reason: 'INTERNAL' });
  }
}

async function flushOnce(boardId: string, items: Pending[]): Promise<void> {
  // 同一批里重复的 opId：与逐条提交时一致，第二条会看到第一条的 `pending` → 判 in-flight
  const seen = new Set<string>();
  const candidates: Pending[] = [];
  for (const item of items) {
    const { opId } = item.input.op;
    if (seen.has(opId)) {
      item.resolve({ kind: 'rejected', opId, reason: 'IDEMPOTENT_IN_FLIGHT' });
      continue;
    }
    seen.add(opId);
    candidates.push(item);
  }
  if (candidates.length === 0) return;

  let claims: (IdemClaim | null)[];
  try {
    claims = await claimOpIdemMany(
      boardId,
      candidates.map((item) => item.input.op.opId),
    );
  } catch (err) {
    rejectAll(candidates, err);
    return;
  }

  const writable: Pending[] = [];
  for (const [index, item] of candidates.entries()) {
    const claim = claims[index] ?? null;
    if (!claim) {
      item.resolve({ kind: 'rejected', opId: item.input.op.opId, reason: 'INTERNAL' });
    } else if (claim.kind === 'done') {
      item.resolve({ kind: 'duplicate', opId: item.input.op.opId, seq: claim.seq });
    } else if (claim.kind === 'in-flight') {
      item.resolve({ kind: 'rejected', opId: item.input.op.opId, reason: 'IDEMPOTENT_IN_FLIGHT' });
    } else {
      writable.push(item);
    }
  }
  if (writable.length === 0) return;

  const opIds = writable.map((item) => item.input.op.opId);

  let start: number;
  try {
    // 稳态一次 Redis 往返；只有 seq 键缺失时才回源 boards.last_seq
    start = await allocateSeqRange(boardId, writable.length, () => getBoardLastSeq(boardId));
  } catch (err) {
    await releaseOpIdemMany(boardId, opIds).catch(() => undefined);
    rejectAll(writable, err);
    return;
  }

  const seqs = writable.map((_, index) => start + index);

  let results: PersistOpResult[];
  try {
    results = await persistOps(
      writable.map((item, index) => ({ ...item.input, seq: seqs[index] as number })),
    );
  } catch (err) {
    await releaseOpIdemMany(boardId, opIds).catch(() => undefined);
    rejectAll(writable, err);
    return;
  }

  try {
    await markOpIdemDoneMany(
      boardId,
      writable.map((item, index) => ({ opId: item.input.op.opId, seq: seqs[index] as number })),
    );
  } catch (err) {
    // 已经提交成功，幂等标记失败不回滚：照常 ack + 广播，重复提交仍有 (board_id, op_id) 唯一约束兜底
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), boardId, ops: writable.length },
      'mark op idempotency failed',
    );
  }

  let edited = false;
  for (const [index, item] of writable.entries()) {
    const result = results[index];
    if (!result) {
      item.resolve({ kind: 'rejected', opId: item.input.op.opId, reason: 'INTERNAL' });
      continue;
    }
    if (result.applied) edited = true;
    item.resolve({
      kind: 'persisted',
      opId: item.input.op.opId,
      seq: seqs[index] as number,
      applied: result.applied,
      stale: result.stale,
    });
  }

  // 一批只标记一次「最近编辑」；LWW 全部落败时不算编辑
  if (edited) await markBoardEdited(boardId);
}
