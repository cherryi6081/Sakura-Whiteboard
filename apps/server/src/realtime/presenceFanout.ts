import type { PresenceState } from './presence.js';

/**
 * 在场名单合帧：join / leave 只标记房间为脏，由定时器每 100ms 聚合一次权威快照并广播。
 *
 * 为什么不在 join handler 里直接广播：原来每次 join 都向房间内 N 个 socket 各写一份全量名单，
 * N 人同时进房就是 O(N²) 的写入（100 人 ≈ 150MB），把 join p95 拖到秒级。合帧后广播次数与
 * 人数解耦（≤10 次/s/房间），且不再占用 join 的响应路径。
 *
 * 一致性口径：每帧都是注册表**当前**的聚合结果（而不是增量），所以丢帧不会造成名单漂移；
 * 断线仍由 `presence.leave` 立即更新注册表，下一帧即被清理；新连接 ≤100ms 内拿到全量。
 *
 * 跨实例：`stateOf` 允许返回 Promise（聚合要读 Redis 共享注册表）。读快照期间的 touch
 * 不再开启第二个并发读，而是记成 pending，等当前这一帧结束后立即补一帧，保证变化不丢。
 */

export const PRESENCE_FRAME_MS = 100;

export type PresenceFanout = {
  /** 标记该房间名单已变化；同一窗口内的多次变化只合并成一次广播。 */
  touch: (boardId: string) => void;
};

const isPromiseLike = <T>(value: T | Promise<T>): value is Promise<T> =>
  typeof (value as Promise<T> | null | undefined)?.then === 'function';

export function createPresenceFanout(
  stateOf: (boardId: string) => PresenceState | Promise<PresenceState>,
  emitState: (state: PresenceState) => void,
  frameMs = PRESENCE_FRAME_MS,
): PresenceFanout {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 正在异步读注册表的房间 */
  const busy = new Set<string>();
  /** 读取期间又被 touch 的房间：本帧结束后补一帧 */
  const pending = new Set<string>();

  const schedule = (boardId: string): void => {
    if (timers.has(boardId)) return;
    const timer = setTimeout(() => flush(boardId), frameMs);
    timer.unref?.();
    timers.set(boardId, timer);
  };

  const broadcast = (state: PresenceState): void => {
    // 名字在注册表里可能已经清空（最后一个人走了）：聚合结果为空是合法的，不需要广播
    if (state.users.length === 0) return;
    try {
      emitState(state);
    } catch {
      // 广播失败不能拖垮合帧循环；下一帧仍是全量快照
    }
  };

  const flush = (boardId: string): void => {
    timers.delete(boardId);
    if (busy.has(boardId)) {
      pending.add(boardId);
      return;
    }

    let result: PresenceState | Promise<PresenceState>;
    try {
      result = stateOf(boardId);
    } catch {
      return;
    }

    // 同步路径保持同步：单实例注册表（含现有单测）不经过微任务，行为与合帧前一致
    if (!isPromiseLike(result)) {
      broadcast(result);
      return;
    }

    busy.add(boardId);
    void result
      .then((state) => broadcast(state))
      .catch(() => undefined)
      .finally(() => {
        busy.delete(boardId);
        if (pending.delete(boardId)) schedule(boardId);
      });
  };

  return {
    touch(boardId) {
      schedule(boardId);
    },
  };
}
