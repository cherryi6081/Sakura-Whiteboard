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
 */

export const PRESENCE_FRAME_MS = 100;

export type PresenceFanout = {
  /** 标记该房间名单已变化；同一窗口内的多次变化只合并成一次广播。 */
  touch: (boardId: string) => void;
};

export function createPresenceFanout(
  stateOf: (boardId: string) => PresenceState,
  emitState: (state: PresenceState) => void,
  frameMs = PRESENCE_FRAME_MS,
): PresenceFanout {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const flush = (boardId: string): void => {
    timers.delete(boardId);
    // 名字在注册表里可能已经清空（最后一个人走了）：聚合结果为空是合法的，不需要广播
    const state = stateOf(boardId);
    if (state.users.length === 0) return;
    emitState(state);
  };

  return {
    touch(boardId) {
      if (timers.has(boardId)) return;
      const timer = setTimeout(() => flush(boardId), frameMs);
      timer.unref?.();
      timers.set(boardId, timer);
    },
  };
}
