import { describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';

vi.mock('../infra/redis.js', () => ({
  ensureRedisConnected: vi.fn(async () => undefined),
  redis: {},
}));

import { createPresenceStore, PRESENCE_TTL_SECONDS } from './presenceStore.js';
import type { PresenceConnectionInput } from './presence.js';

/** 只实现 presenceStore 用到的命令：hset/hdel/expire 走 multi 链，hgetall 直接读。 */
function createFakeRedis() {
  const hashes = new Map<string, Map<string, string>>();
  const hashOf = (key: string) => {
    let map = hashes.get(key);
    if (!map) {
      map = new Map();
      hashes.set(key, map);
    }
    return map;
  };

  const multi = {
    hset(key: string, field: string, value: string) {
      hashOf(key).set(field, value);
      return multi;
    },
    hdel(key: string, ...fields: string[]) {
      for (const field of fields) hashOf(key).delete(field);
      return multi;
    },
    expire() {
      return multi;
    },
    async exec() {
      return [];
    },
  };

  const client = {
    multi: () => multi,
    hgetall: async (key: string) => Object.fromEntries(hashOf(key)),
    hdel: async (key: string, ...fields: string[]) => {
      let removed = 0;
      for (const field of fields) if (hashOf(key).delete(field)) removed += 1;
      return removed;
    },
  };

  return { client: client as unknown as Redis, hashes };
}

const input = (overrides: Partial<PresenceConnectionInput> = {}): PresenceConnectionInput => ({
  boardId: 'm3_board_001',
  connectionId: 'sock_1',
  clientId: 'client_1',
  tabId: 'tab_1',
  identity: 'guest:g_a1',
  role: 'editor',
  color: '#A85C7C',
  displayName: '游客',
  avatarUrl: null,
  joinedAt: 1000,
  ...overrides,
});

describe('presenceStore', () => {
  it('upsert 后 snapshot 能读回连接信息（cursor 固定为 null）', async () => {
    const { client } = createFakeRedis();
    const store = createPresenceStore(client);

    await store.upsert(input());
    const snapshot = await store.snapshot('m3_board_001');

    expect(snapshot).toHaveLength(1);
    expect(snapshot?.[0]).toMatchObject({ connectionId: 'sock_1', identity: 'guest:g_a1', cursor: null });
  });

  it('心跳过期的连接不会出现在快照里，并从 hash 中清掉', async () => {
    const { client, hashes } = createFakeRedis();
    const store = createPresenceStore(client);

    await store.upsert(input({ connectionId: 'sock_live' }));
    await store.upsert(input({ connectionId: 'sock_dead' }));
    const seen = hashes.get('presence:seen:m3_board_001')!;
    seen.set('sock_dead', String(Date.now() - (PRESENCE_TTL_SECONDS + 1) * 1000));

    const snapshot = await store.snapshot('m3_board_001');

    expect(snapshot?.map((conn) => conn.connectionId)).toEqual(['sock_live']);
    expect(hashes.get('presence:conns:m3_board_001')?.has('sock_dead')).toBe(false);
  });

  it('remove 后快照不再包含该连接', async () => {
    const { client } = createFakeRedis();
    const store = createPresenceStore(client);

    await store.upsert(input());
    await store.remove('m3_board_001', 'sock_1');

    expect(await store.snapshot('m3_board_001')).toEqual([]);
  });

  it('Redis 不可用时 snapshot 返回 null，让调用方退化为单实例聚合', async () => {
    const failing = {
      multi: () => {
        throw new Error('redis down');
      },
      hgetall: async () => {
        throw new Error('redis down');
      },
      hdel: async () => 0,
    } as unknown as Redis;
    const store = createPresenceStore(failing);

    expect(await store.snapshot('m3_board_001')).toBeNull();
    // 失败后进入冷却：后续 upsert 直接跳过而不是继续打 Redis
    await expect(store.upsert(input())).resolves.toBeUndefined();
  });
});
