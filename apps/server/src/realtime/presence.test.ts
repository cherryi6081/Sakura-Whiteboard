import { describe, expect, it } from 'vitest';
import {
  aggregatePresence,
  createPresenceRegistry,
  type PresenceConnection,
  type PresenceConnectionInput,
} from './presence.js';

const base = {
  boardId: 'm3_board_001',
  clientId: 'web_client_a1',
  tabId: 'tab_a1',
  identity: 'guest:g_a1',
  role: 'editor' as const,
  color: '#A85C7C',
  joinedAt: 1000,
};

const conn = (overrides: Partial<PresenceConnectionInput> = {}): PresenceConnectionInput => ({
  ...base,
  connectionId: 'sock_a1',
  ...overrides,
});

const withCursor = (input: PresenceConnectionInput): PresenceConnection => ({ ...input, cursor: null });

describe('aggregatePresence', () => {
  it('同一用户的多条连接聚合为一个条目，connectionCount 等于标签页数', () => {
    const state = aggregatePresence('m3_board_001', [
      withCursor(conn({ connectionId: 'sock_a1', tabId: 'tab_a1', joinedAt: 1000 })),
      withCursor(conn({ connectionId: 'sock_a2', tabId: 'tab_a2', joinedAt: 1200 })),
      withCursor(conn({ connectionId: 'sock_b1', clientId: 'web_client_b1', tabId: 'tab_b1', identity: 'guest:g_b1', joinedAt: 1400 })),
    ]);

    expect(state.totalConnections).toBe(3);
    expect(state.users).toHaveLength(2);

    const [userA, userB] = state.users;
    expect(userA?.identity).toBe('guest:g_a1');
    expect(userA?.connectionCount).toBe(2);
    expect(userA?.tabIds).toEqual(['tab_a1', 'tab_a2']);
    expect(userA?.connectionIds).toEqual(['sock_a1', 'sock_a2']);
    expect(userB?.identity).toBe('guest:g_b1');
    expect(userB?.connectionCount).toBe(1);
  });

  it('同一用户多标签权限不同时取最高权限（任一 editor 即 editor）', () => {
    const state = aggregatePresence('m3_board_001', [
      withCursor(conn({ connectionId: 'sock_view', tabId: 'tab_v', role: 'viewer' })),
      withCursor(conn({ connectionId: 'sock_edit', tabId: 'tab_e', role: 'editor', joinedAt: 1100 })),
    ]);
    expect(state.users[0]?.role).toBe('editor');
  });

  it('没有 tabId 的连接不进入 tabIds，但仍计入 connectionCount', () => {
    const state = aggregatePresence('m3_board_001', [
      withCursor(conn({ connectionId: 'sock_old', tabId: null })),
      withCursor(conn({ connectionId: 'sock_new', tabId: 'tab_new', joinedAt: 1100 })),
    ]);
    expect(state.users[0]?.connectionCount).toBe(2);
    expect(state.users[0]?.tabIds).toEqual(['tab_new']);
  });
});

describe('createPresenceRegistry', () => {
  it('join 后按用户聚合；leave 后连接数与用户数同步下降', () => {
    const registry = createPresenceRegistry();
    const state1 = registry.join(conn({ connectionId: 'sock_a1' }));
    expect(state1.totalConnections).toBe(1);

    const state2 = registry.join(conn({ connectionId: 'sock_a2', tabId: 'tab_a2', joinedAt: 1100 }));
    expect(state2.totalConnections).toBe(2);
    expect(state2.users[0]?.connectionCount).toBe(2);

    const state3 = registry.leave('m3_board_001', 'sock_a2');
    expect(state3.totalConnections).toBe(1);
    expect(state3.users[0]?.connectionCount).toBe(1);
    expect(state3.users[0]?.tabIds).toEqual(['tab_a1']);
  });

  it('光标按连接保存，不进用户聚合对象', () => {
    const registry = createPresenceRegistry();
    registry.join(conn({ connectionId: 'sock_a1', tabId: 'tab_a1' }));
    registry.join(conn({ connectionId: 'sock_a2', tabId: 'tab_a2', joinedAt: 1100 }));

    const moved = registry.moveCursor('m3_board_001', 'sock_a1', 0.25, 0.5);
    expect(moved?.cursor).toEqual({ x: 0.25, y: 0.5, at: expect.any(Number) });

    const state = registry.state('m3_board_001');
    expect(state.users[0]?.connectionCount).toBe(2);
    expect(Object.keys(state.users[0] ?? {})).not.toContain('cursor');

    const connections = registry.connections('m3_board_001');
    expect(connections.map((item) => item.cursor?.x ?? null)).toEqual([0.25, null]);
  });

  it('未知连接移动光标不产生状态，也不抛错', () => {
    const registry = createPresenceRegistry();
    expect(registry.moveCursor('m3_board_001', 'missing', 0.1, 0.2)).toBeNull();
    expect(registry.state('m3_board_001').totalConnections).toBe(0);
  });

  it('同一 connectionId 重复 join 覆盖而不是累加（重连不会出现两个自己）', () => {
    const registry = createPresenceRegistry();
    registry.join(conn({ connectionId: 'sock_a1' }));
    const state = registry.join(conn({ connectionId: 'sock_a1', tabId: 'tab_a1_v2', joinedAt: 1300 }));
    expect(state.totalConnections).toBe(1);
    expect(state.users[0]?.tabIds).toEqual(['tab_a1_v2']);
  });

  it('不同板的连接互不可见', () => {
    const registry = createPresenceRegistry();
    registry.join(conn({ connectionId: 'sock_a1' }));
    registry.join(conn({ boardId: 'm3_board_002', connectionId: 'sock_b1', identity: 'guest:g_b1' }));
    expect(registry.state('m3_board_001').totalConnections).toBe(1);
    expect(registry.state('m3_board_002').totalConnections).toBe(1);
    expect(registry.state('m3_board_002').users[0]?.identity).toBe('guest:g_b1');
  });
});
