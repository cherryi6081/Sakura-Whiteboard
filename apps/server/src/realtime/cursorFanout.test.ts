import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CURSOR_FRAME_FAST_MS,
  CURSOR_FRAME_MID_MS,
  CURSOR_FRAME_SLOW_MS,
  createCursorFanout,
  nextCursorFrameMs,
  type CursorFrameEntry,
} from './cursorFanout.js';

const entry = (id: string, x = 0.5): CursorFrameEntry => ({
  connectionId: id,
  clientId: `c_${id}`,
  tabId: null,
  identity: `guest:${id}`,
  color: '#A85C7C',
  displayName: '游客',
  joinedAt: 1,
  x,
  y: 0.5,
});

describe('nextCursorFrameMs', () => {
  it('fast 上切 mid 需要超过 10 个活跃连接', () => {
    expect(nextCursorFrameMs(CURSOR_FRAME_FAST_MS, 10)).toBe(CURSOR_FRAME_FAST_MS);
    expect(nextCursorFrameMs(CURSOR_FRAME_FAST_MS, 11)).toBe(CURSOR_FRAME_MID_MS);
  });

  it('mid 回到 fast 要跌破 7 个连接（迟滞缓冲带 7–10）', () => {
    expect(nextCursorFrameMs(CURSOR_FRAME_MID_MS, 7)).toBe(CURSOR_FRAME_MID_MS);
    expect(nextCursorFrameMs(CURSOR_FRAME_MID_MS, 6)).toBe(CURSOR_FRAME_FAST_MS);
  });

  it('mid 上切 slow 需要超过 36 个连接，slow 回 mid 要跌破 30（缓冲带 30–36）', () => {
    expect(nextCursorFrameMs(CURSOR_FRAME_MID_MS, 36)).toBe(CURSOR_FRAME_MID_MS);
    expect(nextCursorFrameMs(CURSOR_FRAME_MID_MS, 37)).toBe(CURSOR_FRAME_SLOW_MS);
    expect(nextCursorFrameMs(CURSOR_FRAME_SLOW_MS, 30)).toBe(CURSOR_FRAME_SLOW_MS);
    expect(nextCursorFrameMs(CURSOR_FRAME_SLOW_MS, 29)).toBe(CURSOR_FRAME_MID_MS);
  });
});

describe('createCursorFanout 自适应帧间隔', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('小房间用 fast 窗口，帧内同一连接只保留最新位置', () => {
    const frames: CursorFrameEntry[][] = [];
    const fanout = createCursorFanout((_boardId, cursors) => frames.push(cursors));

    fanout.push('b1', entry('a', 0.1));
    fanout.push('b1', entry('a', 0.9));
    fanout.push('b1', entry('b', 0.3));
    vi.advanceTimersByTime(CURSOR_FRAME_FAST_MS);

    expect(frames).toHaveLength(1);
    expect(frames[0]?.map((item) => item.connectionId).sort()).toEqual(['a', 'b']);
    expect(frames[0]?.find((item) => item.connectionId === 'a')?.x).toBe(0.9);
  });

  it('活跃连接升到 12 后，下一个窗口切到 24ms', () => {
    const frames: CursorFrameEntry[][] = [];
    const fanout = createCursorFanout((_boardId, cursors) => frames.push(cursors));
    const ids = Array.from({ length: 12 }, (_, i) => `u${i}`);

    for (const id of ids) fanout.push('b1', entry(id));
    vi.advanceTimersByTime(CURSOR_FRAME_FAST_MS);
    expect(frames).toHaveLength(1);

    for (const id of ids) fanout.push('b1', entry(id));
    vi.advanceTimersByTime(CURSOR_FRAME_FAST_MS);
    expect(frames).toHaveLength(1); // 16ms 还没到 24ms 窗口
    vi.advanceTimersByTime(CURSOR_FRAME_MID_MS - CURSOR_FRAME_FAST_MS);
    expect(frames).toHaveLength(2);
  });

  it('disconnect 会丢掉未发帧，且最后一个连接离开后房间状态被释放', () => {
    const frames: CursorFrameEntry[][] = [];
    const fanout = createCursorFanout((_boardId, cursors) => frames.push(cursors));

    fanout.push('b1', entry('a'));
    fanout.drop('b1', 'a');
    vi.advanceTimersByTime(CURSOR_FRAME_SLOW_MS);
    expect(frames).toHaveLength(0);

    // 房间已释放：新 push 重新按 fast 起步
    fanout.push('b1', entry('b'));
    vi.advanceTimersByTime(CURSOR_FRAME_FAST_MS);
    expect(frames).toHaveLength(1);
  });
});
