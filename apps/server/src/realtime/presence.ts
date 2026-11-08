import type { JoinRole } from '../domain/roles.js';

/**
 * M3：板级在场（presence）的**连接**注册表与**按用户**聚合。
 *
 * 隔离边界（见开发文档 §6.3）：
 * - 一个 socket = 一条连接（`connectionId`）。同一用户同一块板的两个标签 = 两条连接。
 * - 对外的 `presence:state` 按 `identity`（当前是游客 `guest:{guestId}`）聚合：头像一个 + "×N 标签页"。
 * - 光标不进聚合对象：`presence:cursor` 按 `connectionId` 独立广播，两标签视口不同，位置不可合并。
 *
 * 已知边界：注册表是**单实例内存态**。`@socket.io/redis-adapter` 只扇出事件，不共享这份 Map；
 * 双实例部署时每个实例只知道自己连着的连接，聚合结果不完整（与开发文档 §6 的降级说明一致）。
 */

export type PresenceCursor = { x: number; y: number; at: number };

export type PresenceConnectionInput = {
  boardId: string;
  connectionId: string;
  clientId: string;
  /** 每标签一条（sessionStorage）；老客户端未带时为 null */
  tabId: string | null;
  identity: string;
  role: JoinRole;
  color: string;
  joinedAt: number;
};

export type PresenceConnection = PresenceConnectionInput & { cursor: PresenceCursor | null };

export type PresenceUser = {
  identity: string;
  color: string;
  role: JoinRole;
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
      // 同一用户多标签的权限可能不同（例如一标签自报只读）；展示取最高权限
      role: sorted.some((conn) => conn.role === 'editor') ? 'editor' : 'viewer',
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
