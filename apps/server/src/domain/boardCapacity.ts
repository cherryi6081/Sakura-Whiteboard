import type { PoolClient } from 'pg';

/**
 * 白板列表容量与淘汰（用户明确规则）。
 *
 * 规则：
 * - 一个列表作用域最多 15 块；第 16 块创建时先淘汰一块再插入。
 * - 淘汰按「打开次数升序、创建时间升序」取第一块。
 * - 置顶的、刚创建（10 分钟）的、最近编辑/进入过（10 分钟）的都不参与。
 * - 登录用户软删进回收站；游客没有回收站，物理删除。
 *
 * 作用域只覆盖**创建者自己的板**：
 * 团队空间里别人的板不参与淘汰，避免编辑者新建一块就把同事的板删掉。
 * 15 块全部被保护时不做任何删除，返回 429 让用户自己整理。
 */

export const BOARD_CAPACITY = 15;

/** 「刚创建 / 正在编辑」保护窗口 */
export const EVICT_PROTECT_MS = 10 * 60 * 1000;

/** 审计表里记录的排序口径快照 */
export const EVICTION_POLICY = 'opened_count asc, created_at asc, id asc';

export type EvictionCandidate = {
  id: string;
  title: string;
  pinnedAt: Date | null;
  openedCount: number;
  lastOpenedAt: Date | null;
  createdAt: Date;
  lastEditedAt: Date;
};

/**
 * 纯函数：从当前作用域的板里挑出应被淘汰的那一块。
 * 返回 null 表示没有可淘汰的板（未满 / 全被保护）。
 */
export function pickEvictionCandidate<T extends EvictionCandidate>(
  rows: readonly T[],
  options: { now?: Date; pinnedIds?: ReadonlySet<string> } = {},
): T | null {
  if (rows.length < BOARD_CAPACITY) return null;
  const now = (options.now ?? new Date()).getTime();
  const protectBefore = now - EVICT_PROTECT_MS;

  const eligible = rows.filter((row) => {
    if (row.pinnedAt) return false;
    if (options.pinnedIds?.has(row.id)) return false;
    if (row.createdAt.getTime() > protectBefore) return false;
    if (row.lastEditedAt.getTime() > protectBefore) return false;
    if (row.lastOpenedAt && row.lastOpenedAt.getTime() > protectBefore) return false;
    return true;
  });

  eligible.sort((a, b) => {
    if (a.openedCount !== b.openedCount) return a.openedCount - b.openedCount;
    const createdDiff = a.createdAt.getTime() - b.createdAt.getTime();
    if (createdDiff !== 0) return createdDiff;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return eligible[0] ?? null;
}

export type EvictionScope =
  | { kind: 'user'; userId: string; spaceId: string; mode: 'trash' }
  | { kind: 'guest'; guestId: string; pinnedIds: readonly string[]; mode: 'purged' };

export type EvictionResult = {
  id: string;
  title: string;
  openedCount: number;
  lastOpenedAt: Date | null;
  createdAt: Date;
  mode: 'trash' | 'purged';
};

/**
 * 淘汰结果：
 * - none    还没满 15，不需要淘汰；
 * - evicted 已删除并写好审计；
 * - blocked 已满 15 但全部被保护，调用方应返回 429，不能删任何一块。
 */
export type EvictionOutcome =
  | { kind: 'none' }
  | { kind: 'evicted'; board: EvictionResult }
  | { kind: 'blocked' };

type EvictionRow = {
  id: string;
  title: string;
  pinned_at: Date | null;
  opened_count: number;
  last_opened_at: Date | null;
  created_at: Date;
  last_edited_at: Date;
};

const SELECT_COLUMNS = `id, title, pinned_at, opened_count, last_opened_at, created_at, last_edited_at`;

/**
 * 在调用方的事务里执行「满 15 就淘汰一块」。
 *
 * 调用方必须先拿 `pg_advisory_xact_lock`（按 owner 维度），否则并发创建会基于
 * 过期计数同时挑中同一块板，或各自淘汰一块。
 *
 * 返回 `none` 表示还没满 15；`evicted` 表示已删除并写好审计；
 * `blocked` 表示满 15 但没有可淘汰的板，调用方返回 429。
 */
export async function evictForCapacity(
  client: PoolClient,
  scope: EvictionScope,
  triggerBoardId: string,
): Promise<EvictionOutcome> {
  const { rows } = scope.kind === 'user'
    ? await client.query<EvictionRow>(
        `select ${SELECT_COLUMNS}
           from boards
          where space_id = $1 and owner_id = $2
            and deleted_at is null and archived_at is null
          order by id
          for update`,
        [scope.spaceId, scope.userId],
      )
    : await client.query<EvictionRow>(
        `select ${SELECT_COLUMNS}
           from boards
          where owner_guest_id = $1
            and deleted_at is null and archived_at is null
          order by id
          for update`,
        [scope.guestId],
      );

  if (rows.length < BOARD_CAPACITY) return { kind: 'none' };

  const candidates = rows.map((row) => ({
    id: row.id,
    title: row.title,
    pinnedAt: row.pinned_at,
    openedCount: row.opened_count,
    lastOpenedAt: row.last_opened_at,
    createdAt: row.created_at,
    lastEditedAt: row.last_edited_at,
  }));

  const chosen = pickEvictionCandidate(
    candidates,
    scope.kind === 'guest' ? { pinnedIds: new Set(scope.pinnedIds) } : {},
  );
  if (!chosen) return { kind: 'blocked' };

  if (scope.mode === 'trash') {
    await client.query('update boards set deleted_at = now() where id = $1 and deleted_at is null', [chosen.id]);
  } else {
    // 游客没有回收站：与现有游客删除语义一致，直接物理删除
    await client.query('delete from boards where id = $1 and owner_guest_id = $2', [chosen.id, scope.guestId]);
  }

  await client.query(
    `insert into board_evictions
       (board_id, board_title, owner_id, owner_guest_id, space_id, trigger_board_id,
        policy, opened_count, last_opened_at, board_created_at, mode)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      chosen.id,
      chosen.title,
      scope.kind === 'user' ? scope.userId : null,
      scope.kind === 'guest' ? scope.guestId : null,
      scope.kind === 'user' ? scope.spaceId : null,
      triggerBoardId,
      EVICTION_POLICY,
      chosen.openedCount,
      chosen.lastOpenedAt,
      chosen.createdAt,
      scope.mode,
    ],
  );

  console.info('[boards] capacity eviction', {
    boardId: chosen.id,
    title: chosen.title,
    ownerId: scope.kind === 'user' ? scope.userId : null,
    guestId: scope.kind === 'guest' ? scope.guestId : null,
    spaceId: scope.kind === 'user' ? scope.spaceId : null,
    triggerBoardId,
    policy: EVICTION_POLICY,
    openedCount: chosen.openedCount,
    createdAt: chosen.createdAt.toISOString(),
    mode: scope.mode,
  });

  return {
    kind: 'evicted',
    board: {
      id: chosen.id,
      title: chosen.title,
      openedCount: chosen.openedCount,
      lastOpenedAt: chosen.lastOpenedAt,
      createdAt: chosen.createdAt,
      mode: scope.mode,
    },
  };
}
