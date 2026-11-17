import type { PoolClient } from 'pg';
import {
  BOARD_CAPACITY as SHARED_BOARD_CAPACITY,
  GUEST_BOARDS_PER_24H as SHARED_GUEST_BOARDS_PER_24H,
} from '@whiteboard/shared';

/**
 * 游客（临时板）容量与淘汰。
 *
 * 规则：
 * - **12 块上限只针对游客**；登录账号不设上限，建板/恢复都不做容量判定。
 * - 游客第 13 块创建时先淘汰一块再插入。
 * - 淘汰按「打开次数升序、创建时间升序」取第一块。
 * - 置顶的、刚创建（10 分钟）的、最近编辑/进入过（10 分钟）的都不参与。
 * - 游客没有回收站，淘汰即物理删除，审计仍写 `board_evictions`。
 * - 12 块全部被保护时不做任何删除，返回 blocked，调用方返回 429。
 *
 * 容量数字只有一处权威来源（`@whiteboard/shared` 的 `BOARD_CAPACITY`），这里只做转出。
 */

export const BOARD_CAPACITY = SHARED_BOARD_CAPACITY;

/** 游客 24h 建板频率上限，同样只做转出，避免接口与文案各写一个数字 */
export const GUEST_BOARDS_PER_24H = SHARED_GUEST_BOARDS_PER_24H;

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

export type EvictionOptions = { now?: Date; pinnedIds?: ReadonlySet<string> };

/** 单块是否可淘汰：置顶、刚创建、最近编辑/进入过（10 分钟）的一律不动。 */
export function isEvictionEligible(row: EvictionCandidate, options: EvictionOptions = {}): boolean {
  const protectBefore = (options.now ?? new Date()).getTime() - EVICT_PROTECT_MS;
  if (row.pinnedAt) return false;
  if (options.pinnedIds?.has(row.id)) return false;
  if (row.createdAt.getTime() > protectBefore) return false;
  if (row.lastEditedAt.getTime() > protectBefore) return false;
  if (row.lastOpenedAt && row.lastOpenedAt.getTime() > protectBefore) return false;
  return true;
}

/** 全部可淘汰候选，按「打开次数升序 → 创建时间升序 → id」排好。 */
export function listEvictionCandidates<T extends EvictionCandidate>(
  rows: readonly T[],
  options: EvictionOptions = {},
): T[] {
  return rows
    .filter((row) => isEvictionEligible(row, options))
    .sort((a, b) => {
      if (a.openedCount !== b.openedCount) return a.openedCount - b.openedCount;
      const createdDiff = a.createdAt.getTime() - b.createdAt.getTime();
      if (createdDiff !== 0) return createdDiff;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

/**
 * 纯函数：从当前作用域的板里挑出应被淘汰的那一块。
 * 返回 null 表示没有可淘汰的板（未满 / 全被保护）。
 */
export function pickEvictionCandidate<T extends EvictionCandidate>(
  rows: readonly T[],
  options: EvictionOptions = {},
): T | null {
  if (rows.length < BOARD_CAPACITY) return null;
  return listEvictionCandidates(rows, options)[0] ?? null;
}

/** 容量只作用于游客：淘汰即物理删除。 */
export type EvictionScope = { kind: 'guest'; guestId: string; pinnedIds: readonly string[] };

export type EvictionResult = {
  id: string;
  title: string;
  openedCount: number;
  lastOpenedAt: Date | null;
  createdAt: Date;
};

/**
 * 淘汰结果：
 * - none    还没满 12，不需要淘汰；
 * - evicted 已删除并写好审计；
 * - blocked 已满 12 但全部被保护，调用方应返回 429，不能删任何一块。
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

function toCandidate(row: EvictionRow): EvictionCandidate {
  return {
    id: row.id,
    title: row.title,
    pinnedAt: row.pinned_at,
    openedCount: row.opened_count,
    lastOpenedAt: row.last_opened_at,
    createdAt: row.created_at,
    lastEditedAt: row.last_edited_at,
  };
}

function pinnedOf(scope: EvictionScope): ReadonlySet<string> {
  return new Set(scope.pinnedIds);
}

/** 只读查询用：池子与事务客户端都满足 */
type Queryable = Pick<PoolClient, 'query'>;

/** 读取游客名下全部未归档的临时板（可加行锁）。 */
export async function loadGuestBoards(
  client: Queryable,
  guestId: string,
  { forUpdate = false }: { forUpdate?: boolean } = {},
): Promise<EvictionCandidate[]> {
  const lock = forUpdate ? ' for update' : '';
  const { rows } = await client.query<EvictionRow>(
    `select ${SELECT_COLUMNS}
       from boards
      where owner_guest_id = $1
        and deleted_at is null and archived_at is null
      order by id${lock}`,
    [guestId],
  );
  return rows.map(toCandidate);
}

/** 删除 + 审计 + 日志：游客没有回收站，直接物理删除。 */
async function removeBoard(
  client: PoolClient,
  scope: EvictionScope,
  chosen: EvictionCandidate,
  triggerBoardId: string,
): Promise<EvictionResult> {
  await client.query('delete from boards where id = $1 and owner_guest_id = $2', [chosen.id, scope.guestId]);

  await client.query(
    `insert into board_evictions
       (board_id, board_title, owner_guest_id, trigger_board_id,
        policy, opened_count, last_opened_at, board_created_at, mode, trigger)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'purged', 'create')`,
    [
      chosen.id,
      chosen.title,
      scope.guestId,
      triggerBoardId,
      EVICTION_POLICY,
      chosen.openedCount,
      chosen.lastOpenedAt,
      chosen.createdAt,
    ],
  );

  console.info('[boards] capacity eviction', {
    boardId: chosen.id,
    title: chosen.title,
    guestId: scope.guestId,
    triggerBoardId,
    trigger: 'create',
    policy: EVICTION_POLICY,
    openedCount: chosen.openedCount,
    createdAt: chosen.createdAt.toISOString(),
    mode: 'purged',
  });

  return {
    id: chosen.id,
    title: chosen.title,
    openedCount: chosen.openedCount,
    lastOpenedAt: chosen.lastOpenedAt,
    createdAt: chosen.createdAt,
  };
}

/**
 * 在调用方的事务里执行「游客满 12 就淘汰一块」。
 *
 * 调用方必须先拿 `pg_advisory_xact_lock`（游客维度），否则并发创建会基于
 * 过期计数同时挑中同一块板，或各自淘汰一块。
 *
 * 返回 `none` 表示还没满 12；`evicted` 表示已删除并写好审计；
 * `blocked` 表示满 12 但没有可淘汰的板，调用方返回 429。
 */
export async function evictForCapacity(
  client: PoolClient,
  scope: EvictionScope,
  triggerBoardId: string,
): Promise<EvictionOutcome> {
  const candidates = await loadGuestBoards(client, scope.guestId, { forUpdate: true });
  if (candidates.length < BOARD_CAPACITY) return { kind: 'none' };

  const chosen = pickEvictionCandidate(candidates, { pinnedIds: pinnedOf(scope) });
  if (!chosen) return { kind: 'blocked' };

  return { kind: 'evicted', board: await removeBoard(client, scope, chosen, triggerBoardId) };
}
