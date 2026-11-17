import type { Redis } from 'ioredis';
import { ensureRedisConnected, redis } from '../infra/redis.js';
import type { PresenceConnection, PresenceConnectionInput } from './presence.js';

/**
 * 跨实例 presence 共享注册表（Redis）。
 *
 * `@socket.io/redis-adapter` 只扇出事件，不共享每个实例内存里的连接表；双实例部署时
 * 单看本实例会漏掉对面实例上的用户。这里把每条连接写进 Redis，聚合时再和本地注册表
 * 合并（同一 connectionId 本地优先），名单因此是全局完整的。
 *
 * 键设计（按板两个 hash，避免逐连接 SCAN）：
 * - `presence:conns:<boardId>`：field = connectionId，value = JSON(PresenceConnectionInput)
 * - `presence:seen:<boardId>`：field = connectionId，value = 最近一次心跳/写入的毫秒时间戳
 *
 * 失效口径：实例崩溃后没人删它的记录，靠 `seen` 的 STALE_MS 过滤 + TTL 兜底。
 * 正常在线的连接由 `touch`（board.ts 里 25s 一次的心跳）续约。
 *
 * 降级：Redis 不可用时所有方法静默失败（`snapshot` 返回 null），调用方退回单实例聚合，
 * 不影响 join/leave 与本地广播；失败后 5s 内不再重试，避免每帧都去连一次 Redis。
 */

const CONNS_PREFIX = 'presence:conns:';
const SEEN_PREFIX = 'presence:seen:';

/** 单板两个 hash 的 TTL；心跳间隔应显著小于它（见 PRESENCE_HEARTBEAT_MS）。 */
export const PRESENCE_TTL_SECONDS = 60;
/** 心跳间隔：25s 一次，允许漏掉一次仍不会过期。 */
export const PRESENCE_HEARTBEAT_MS = 25_000;

const STALE_MS = PRESENCE_TTL_SECONDS * 1000;
/** Redis 失败后的冷却窗口，防止 presence 合帧把失败的连接尝试放大成风暴。 */
const RETRY_COOLDOWN_MS = 5_000;

export type PresenceStore = ReturnType<typeof createPresenceStore>;

export function createPresenceStore(client: Redis = redis) {
  let retryAfter = 0;

  const connsKey = (boardId: string) => `${CONNS_PREFIX}${boardId}`;
  const seenKey = (boardId: string) => `${SEEN_PREFIX}${boardId}`;
  const cooling = () => Date.now() < retryAfter;
  const markDown = () => {
    retryAfter = Date.now() + RETRY_COOLDOWN_MS;
  };

  return {
    /** 连接加入时写入完整信息（对应本地 `presence.join`）。 */
    async upsert(input: PresenceConnectionInput): Promise<void> {
      if (cooling()) return;
      try {
        await ensureRedisConnected();
        const conns = connsKey(input.boardId);
        const seen = seenKey(input.boardId);
        await client
          .multi()
          .hset(conns, input.connectionId, JSON.stringify(input))
          .hset(seen, input.connectionId, String(Date.now()))
          .expire(conns, PRESENCE_TTL_SECONDS)
          .expire(seen, PRESENCE_TTL_SECONDS)
          .exec();
      } catch {
        markDown();
      }
    },

    /** 心跳续约：只刷新 lastSeen 与 TTL，连接信息本身不变。 */
    async touch(boardId: string, connectionId: string): Promise<void> {
      if (cooling()) return;
      try {
        await ensureRedisConnected();
        const conns = connsKey(boardId);
        const seen = seenKey(boardId);
        await client
          .multi()
          .hset(seen, connectionId, String(Date.now()))
          .expire(seen, PRESENCE_TTL_SECONDS)
          .expire(conns, PRESENCE_TTL_SECONDS)
          .exec();
      } catch {
        markDown();
      }
    },

    /**
     * 角色变更：把该用户在本板的所有连接记录改成新角色。
     * 连接信息是整段 JSON，只能先读出再按 field 覆盖（角色变更很少，开销可接受）。
     */
    async updateRole(boardId: string, identity: string, role: PresenceConnectionInput['role']): Promise<void> {
      if (cooling()) return;
      try {
        await ensureRedisConnected();
        const conns = connsKey(boardId);
        const raw = await client.hgetall(conns);
        const updates: Array<[string, string]> = [];
        for (const [connectionId, value] of Object.entries(raw ?? {})) {
          let parsed: PresenceConnectionInput;
          try {
            parsed = JSON.parse(value) as PresenceConnectionInput;
          } catch {
            continue;
          }
          if (parsed.identity !== identity || parsed.role === role) continue;
          updates.push([connectionId, JSON.stringify({ ...parsed, role })]);
        }
        if (updates.length === 0) return;
        const multi = client.multi();
        for (const [connectionId, value] of updates) multi.hset(conns, connectionId, value);
        multi.expire(conns, PRESENCE_TTL_SECONDS);
        await multi.exec();
      } catch {
        markDown();
      }
    },

    /** 正常断线：立即移除；残留记录由 TTL / STALE_MS 兜底。 */
    async remove(boardId: string, connectionId: string): Promise<void> {      if (cooling()) return;
      try {
        await ensureRedisConnected();
        await client
          .multi()
          .hdel(connsKey(boardId), connectionId)
          .hdel(seenKey(boardId), connectionId)
          .exec();
      } catch {
        markDown();
      }
    },

    /**
     * 读取该板所有实例的连接快照（不含光标——光标走独立的合帧广播）。
     * 返回 null 表示 Redis 不可用，调用方应退化为只聚合本地注册表。
     */
    async snapshot(boardId: string): Promise<PresenceConnection[] | null> {
      if (cooling()) return null;
      try {
        await ensureRedisConnected();
        const [rawConns, rawSeen] = await Promise.all([
          client.hgetall(connsKey(boardId)),
          client.hgetall(seenKey(boardId)),
        ]);

        const now = Date.now();
        const connections: PresenceConnection[] = [];
        const stale: string[] = [];

        for (const [connectionId, raw] of Object.entries(rawConns ?? {})) {
          const lastSeen = Number((rawSeen ?? {})[connectionId] ?? Number.NaN);
          if (!Number.isFinite(lastSeen) || now - lastSeen > STALE_MS) {
            stale.push(connectionId);
            continue;
          }
          try {
            const parsed = JSON.parse(raw) as PresenceConnectionInput;
            connections.push({ ...parsed, cursor: null });
          } catch {
            stale.push(connectionId);
          }
        }

        // 顺手清掉崩溃实例留下的幽灵记录，别让每个快照都带着它们
        if (stale.length > 0) {
          void Promise.all([
            client.hdel(connsKey(boardId), ...stale),
            client.hdel(seenKey(boardId), ...stale),
          ]).catch(() => undefined);
        }

        return connections;
      } catch {
        markDown();
        return null;
      }
    },
  };
}
