import type { AccessRole } from '../domain/access.js';

/**
 * M3：板级在场（presence）的**连接**注册表与**按用户**聚合。
 *
 * 隔离边界（见开发文档 §6.3）：
 * - 一个 socket = 一条连接（`connectionId`）。同一用户同一块板的两个标签 = 两条连接。
 * - 对外的 `presence:state` 按 `identity` 聚合：登录用户是 `user:{userId}`（多浏览器 / 多标签都并成一个人），
 *   游客是 `guest:{guestId}`（guestId 存在各自浏览器的 cookie 里，不同浏览器天然是两个人）。
 *   聚合后是头像一个 + "×N 标签页"。
 * - 光标不进聚合对象：按 `connectionId` 独立走合帧广播（`presence:cursor:frame`），两标签视口不同，
 *   位置不可合并。
 *
 * 本模块只是**单实例**的连接注册表。跨实例的完整名单由 `presenceStore`（Redis 共享注册表）
 * 在 `board.ts` 里与本注册表按 connectionId 合并；Redis 不可用时退化为单实例聚合。
 */

export type PresenceCursor = { x: number; y: number; at: number };

export type PresenceConnectionInput = {
  boardId: string;
  connectionId: string;
  clientId: string;
  /** 每标签一条（sessionStorage）；老客户端未带时为 null */
  tabId: string | null;
  identity: string;
  role: AccessRole;
  color: string;
  /** 展示用昵称：登录用户取 `users.display_name`，游客为「游客」 */
  displayName: string;
  /** 登录用户的头像地址（GitHub 等）；游客 / 未设置时为 null */
  avatarUrl?: string | null;
  joinedAt: number;
};

export type PresenceConnection = PresenceConnectionInput & { cursor: PresenceCursor | null };

export type PresenceUser = {
  identity: string;
  color: string;
  displayName: string;
  avatarUrl: string | null;
  role: AccessRole;
  /** 该用户最早一条连接的加入时间：客户端用它作为「最近活动」的空闲判定基线 */
  joinedAt: number;
  /** 该用户在本板的连接数（= 标签页数，同一标签重连会被顶层 map 覆盖而不是相加） */
  connectionCount: number;
  tabIds: string[];
  connectionIds: string[];
};

export type PresenceState = {
  boardId: string;
  users: PresenceUser[];
  totalConnections: number;
  at: number;
};

/**
 * 纯聚合：同一 `identity` 的多条连接合并为一个用户条目。
 * 顺序按最早 `joinedAt`，便于两端渲染稳定顺序。
 */
export function aggregatePresence(
  boardId: string,
  connections: readonly PresenceConnection[],
  at = Date.now(),
): PresenceState {
  const groups = new Map<string, PresenceConnection[]>();
  for (const conn of connections) {
    const list = groups.get(conn.identity);
    if (list) list.push(conn);
    else groups.set(conn.identity, [conn]);
  }

  const users: PresenceUser[] = [...groups.entries()].map(([identity, list]) => {
    const sorted = [...list].sort((a, b) => a.joinedAt - b.joinedAt);
    const first = sorted[0] as PresenceConnection;
    const tabIds = sorted.map((conn) => conn.tabId).filter((tabId): tabId is string => tabId !== null);
    return {
      identity,
      color: first.color,
      // 同一用户多标签昵称相同；取最早加入那条的，保持稳定
      displayName: first.displayName,
      avatarUrl: first.avatarUrl ?? null,
      // 同一用户多标签的权限可能不同（例如一标签自报只读）；展示取最高权限
      role: sorted.some((conn) => conn.role === 'owner')
        ? 'owner'
        : sorted.some((conn) => conn.role === 'editor')
          ? 'editor'
          : 'viewer',
      joinedAt: first.joinedAt,
      connectionCount: sorted.length,
      tabIds: [...new Set(tabIds)],
      connectionIds: sorted.map((conn) => conn.connectionId),
    };
  });

  users.sort((a, b) => {
    const aFirst = connections.find((conn) => conn.identity === a.identity)?.joinedAt ?? 0;
    const bFirst = connections.find((conn) => conn.identity === b.identity)?.joinedAt ?? 0;
    return aFirst - bFirst;
  });

  return { boardId, users, totalConnections: connections.length, at };
}

export type PresenceRegistry = ReturnType<typeof createPresenceRegistry>;

/**
 * 跨实例合并：Redis 共享注册表的快照 + 本地注册表，按 `connectionId` 去重。
 * 同一 id 时本地优先——本地记录的 role/joinedAt 一定比 Redis 里的旧副本新。
 */
export function mergePresenceConnections(
  local: readonly PresenceConnection[],
  remote: readonly PresenceConnection[],
): PresenceConnection[] {
  const merged = new Map<string, PresenceConnection>();
  for (const conn of remote) merged.set(conn.connectionId, conn);
  for (const conn of local) merged.set(conn.connectionId, conn);
  return [...merged.values()];
}

/** 每实例一份的内存注册表；测试与 board.ts 共用。 */
export function createPresenceRegistry() {
  const boards = new Map<string, Map<string, PresenceConnection>>();

  const boardMap = (boardId: string) => {
    let map = boards.get(boardId);
    if (!map) {
      map = new Map();
      boards.set(boardId, map);
    }
    return map;
  };

  return {
    join(input: PresenceConnectionInput): PresenceState {
      const map = boardMap(input.boardId);
      const previous = map.get(input.connectionId);
      map.set(input.connectionId, { ...input, cursor: previous?.cursor ?? null });
      return aggregatePresence(input.boardId, [...map.values()]);
    },
    leave(boardId: string, connectionId: string): PresenceState {
      const map = boards.get(boardId);
      if (map) {
        map.delete(connectionId);
        if (map.size === 0) boards.delete(boardId);
      }
      return aggregatePresence(boardId, map ? [...map.values()] : []);
    },
    moveCursor(boardId: string, connectionId: string, x: number, y: number): PresenceConnection | null {
      const conn = boards.get(boardId)?.get(connectionId);
      if (!conn) return null;
      conn.cursor = { x, y, at: Date.now() };
      return conn;
    },
    /**
     * 角色变更：把该用户在本板的**所有本地连接**改成新角色。
     * 名单里的角色取多连接最高值，改完需要重算一帧（调用方负责 touch）。
     */
    setRole(boardId: string, identity: string, role: AccessRole): void {
      const map = boards.get(boardId);
      if (!map) return;
      for (const conn of map.values()) {
        if (conn.identity === identity) conn.role = role;
      }
    },
    connection(boardId: string, connectionId: string): PresenceConnection | null {
      return boards.get(boardId)?.get(connectionId) ?? null;
    },
    state(boardId: string): PresenceState {
      const map = boards.get(boardId);
      return aggregatePresence(boardId, map ? [...map.values()] : []);
    },
    connections(boardId: string): PresenceConnection[] {
      const map = boards.get(boardId);
      return map ? [...map.values()] : [];
    },
  };
}
