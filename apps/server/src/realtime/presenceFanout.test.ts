import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPresenceFanout, PRESENCE_FRAME_MS } from './presenceFanout.js';
import type { PresenceState } from './presence.js';

const state = (totalConnections: number): PresenceState => ({
  boardId: 'm3_board_001',
  users:
    totalConnections === 0
      ? []
      : [
          {
            identity: 'guest:g_a1',
            color: '#A85C7C',
            displayName: '游客',
            avatarUrl: null,
            role: 'editor',
            connectionCount: totalConnections,
            tabIds: ['tab_a1'],
            connectionIds: Array.from({ length: totalConnections }, (_, i) => `sock_${i}`),
          },
        ],
  totalConnections,
  at: 1000,
});

describe('createPresenceFanout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('同一窗口内的多次变化只广播一次，且发出的是 flush 时刻的最新状态', () => {
    let connections = 0;
    const emitted: PresenceState[] = [];
    const fanout = createPresenceFanout(
      () => state(connections),
      (next) => emitted.push(next),
    );

    fanout.touch('m3_board_001');
    connections = 1;
    fanout.touch('m3_board_001');
    connections = 2;
    fanout.touch('m3_board_001');
    expect(emitted).toHaveLength(0);

    vi.advanceTimersByTime(PRESENCE_FRAME_MS);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.totalConnections).toBe(2);
  });

  it('窗口结束后再次 touch 会开启新一帧', () => {
    let connections = 1;
    const emitted: PresenceState[] = [];
    const fanout = createPresenceFanout(
      () => state(connections),
      (next) => emitted.push(next),
    );

    fanout.touch('m3_board_001');
    vi.advanceTimersByTime(PRESENCE_FRAME_MS);
    connections = 2;
    fanout.touch('m3_board_001');
    vi.advanceTimersByTime(PRESENCE_FRAME_MS);

    expect(emitted.map((item) => item.totalConnections)).toEqual([1, 2]);
  });

  it('房间已空时不广播空名单（最后一个人离开无需通知任何人）', () => {
    const emitted: PresenceState[] = [];
    const fanout = createPresenceFanout(
      () => state(0),
      (next) => emitted.push(next),
    );

    fanout.touch('m3_board_001');
    vi.advanceTimersByTime(PRESENCE_FRAME_MS);

    expect(emitted).toHaveLength(0);
  });
});
