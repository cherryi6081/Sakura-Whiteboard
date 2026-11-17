/**
 * 光标合帧器：每个房间一个合帧窗口，窗口内**每个连接只保留最新位置**，到点后合并成一条消息发出。
 *
 * 为什么能省 CPU：
 * - 原来每条 `cursor:move` 都要 `ns.to(room).emit` 一次，socket.io 要为每个接收者编码一次包，
 *   redis adapter 还要 PUBLISH 一次；成本是 `O(N × Hz)`。
 * - 合帧后每个房间每帧只 emit / PUBLISH 一次，载荷里带本帧移动过的连接（每个连接一条）。
 *
 * 自适应帧间隔：
 * - 3 人以下的小房间不需要 30fps 的批量能力，固定 33ms 会让光标明显"慢半拍"；人多时又要靠大的
 *   窗口摊薄扇出成本。因此按房间内**最近仍在动的连接数**在 14 / 24 / 33ms 三档间切换。
 * - 切档带迟滞：上切与下切用不同阈值（中间留 4–7 个连接的缓冲带），避免人数在阈值附近时来回跳。
 * - 每档都是固定窗口 + 帧内 latest-wins，语义与固定 33ms 时完全一致。
 *
 * 语义：
 * - 中间帧可以丢，但窗口结束时一定会把每个连接的最新位置发出去（`push` 落进 pending，定时器必达）；
 * - 每个连接每帧最多一条、帧按顺序发出，因此同一连接的位置不会倒退。
 *
 * 单实例内存态：连接只存在于一台实例上，它的光标也只由那台实例合帧，跨实例不会重复。
 */

export type CursorFrameEntry = {
  connectionId: string;
  clientId: string;
  tabId: string | null;
  identity: string;
  color: string;
  displayName: string;
  joinedAt: number;
  x: number;
  y: number;
  /** 客户端诊断时间戳（压测/调试用），原样回传，不参与任何服务端逻辑 */
  t?: number;
};

/**
 * 小房间：约 70fps 的合帧窗口，观感接近不合并，同时仍能把同一连接的多次移动压成一条。
 *
 * 取 14 而不是 16：Windows 的定时器粒度是 15.625ms，`setTimeout(16)` 会被抬到约 31ms（两跳），
 * `setTimeout(14)` 稳定落在一跳内（实测 p95 16.6ms）。Linux/macOS 上 14ms 就是 14ms。
 */
export const CURSOR_FRAME_FAST_MS = 14;
/** 中等房间：约 40fps。 */
export const CURSOR_FRAME_MID_MS = 24;
/** 大房间：约 30fps，把扇出成本摊到与固定帧率版本相同的水平。 */
export const CURSOR_FRAME_SLOW_MS = 33;
/** 超过这个时长没动过的连接不计入"活跃"，避免把围观者算进档位。 */
export const CURSOR_ACTIVE_TTL_MS = 2000;

/** 活跃连接数上切阈值：>10 从 fast 升到 mid；>36 从 mid 升到 slow。 */
export const CURSOR_UPGRADE_TO_MID = 10;
export const CURSOR_UPGRADE_TO_SLOW = 36;
/** 下切阈值（迟滞）：<7 回到 fast；<30 回到 mid。与上切阈值之间留出缓冲带。 */
export const CURSOR_DOWNGRADE_TO_FAST = 7;
export const CURSOR_DOWNGRADE_TO_MID = 30;

/**
 * 根据当前窗口与活跃连接数算下一窗口的帧间隔。纯函数，便于单测与解释阈值。
 *
 * 迟滞示意（活跃连接数）：
 * ```
 * fast  1 —— 10/11 ——> mid      11..36 期间保持 mid
 * mid   7/6 <——       fast      6 以下才回 fast
 * mid   36/37 ——>     slow
 * slow  30/29 <——     mid       29 以下才回 mid
 * ```
 */
export function nextCursorFrameMs(current: number, active: number): number {
  if (current <= CURSOR_FRAME_FAST_MS) {
    return active > CURSOR_UPGRADE_TO_MID ? CURSOR_FRAME_MID_MS : CURSOR_FRAME_FAST_MS;
  }
  if (current >= CURSOR_FRAME_SLOW_MS) {
    return active < CURSOR_DOWNGRADE_TO_MID ? CURSOR_FRAME_MID_MS : CURSOR_FRAME_SLOW_MS;
  }
  if (active < CURSOR_DOWNGRADE_TO_FAST) return CURSOR_FRAME_FAST_MS;
  if (active > CURSOR_UPGRADE_TO_SLOW) return CURSOR_FRAME_SLOW_MS;
  return CURSOR_FRAME_MID_MS;
}

type RoomFrame = {
  pending: Map<string, CursorFrameEntry>;
  /** connectionId → 最后一次移动时间，用来估计房间的人数档位 */
  active: Map<string, number>;
  timer: NodeJS.Timeout | null;
  /** 房间静默后延迟释放，避免按板泄漏状态 */
  idleTimer: NodeJS.Timeout | null;
  frameMs: number;
};

export type CursorFanout = {
  push(boardId: string, entry: CursorFrameEntry): void;
  /** 连接断开时丢掉它还没发出的那一帧，避免"幽灵光标" */
  drop(boardId: string, connectionId: string): void;
};

export function createCursorFanout(
  emitFrame: (boardId: string, cursors: CursorFrameEntry[]) => void,
): CursorFanout {
  const rooms = new Map<string, RoomFrame>();

  const flush = (boardId: string): void => {
    const room = rooms.get(boardId);
    if (!room) return;
    room.timer = null;

    const now = Date.now();
    for (const [connectionId, at] of room.active) {
      if (now - at > CURSOR_ACTIVE_TTL_MS) room.active.delete(connectionId);
    }

    const cursors = [...room.pending.values()];
    room.pending.clear();
    // 用本窗口的活跃连接数决定下一个窗口，切换只发生在窗口边界，天然不会中途抖动
    room.frameMs = nextCursorFrameMs(room.frameMs, room.active.size);
    if (cursors.length > 0) emitFrame(boardId, cursors);

    if (room.pending.size === 0) {
      if (room.active.size === 0) {
        rooms.delete(boardId);
        return;
      }
      if (!room.idleTimer) {
        room.idleTimer = setTimeout(() => {
          room.idleTimer = null;
          if (room.pending.size === 0 && room.timer === null) rooms.delete(boardId);
        }, CURSOR_ACTIVE_TTL_MS);
        room.idleTimer.unref?.();
      }
    }
  };

  const schedule = (boardId: string, room: RoomFrame): void => {
    if (room.timer) return;
    room.timer = setTimeout(() => flush(boardId), room.frameMs);
    room.timer.unref?.();
  };

  return {
    push(boardId, entry) {
      let room = rooms.get(boardId);
      if (!room) {
        // 新房间从 fast 起步：绝大多数板子人少，第一帧就该跟手；人多时 1–2 帧内升档
        room = {
          pending: new Map(),
          active: new Map(),
          timer: null,
          idleTimer: null,
          frameMs: CURSOR_FRAME_FAST_MS,
        };
        rooms.set(boardId, room);
      }
      if (room.idleTimer) {
        clearTimeout(room.idleTimer);
        room.idleTimer = null;
      }
      room.active.set(entry.connectionId, Date.now());
      // 同一连接同一窗口内多次移动：只保留最后一次，直接覆盖
      room.pending.set(entry.connectionId, entry);
      schedule(boardId, room);
    },

    drop(boardId, connectionId) {
      const room = rooms.get(boardId);
      if (!room) return;
      room.pending.delete(connectionId);
      room.active.delete(connectionId);
      if (room.pending.size === 0 && room.active.size === 0) {
        if (room.timer) {
          clearTimeout(room.timer);
          room.timer = null;
        }
        if (room.idleTimer) {
          clearTimeout(room.idleTimer);
          room.idleTimer = null;
        }
        rooms.delete(boardId);
      }
    },
  };
}
