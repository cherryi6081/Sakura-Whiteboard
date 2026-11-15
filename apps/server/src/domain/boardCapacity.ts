import type { PoolClient } from 'pg';
import { BOARD_CAPACITY as SHARED_BOARD_CAPACITY } from '@whiteboard/shared';

/**
 * 白板列表容量与淘汰（用户明确规则）。
 *
 * 规则：
 * - 一个列表作用域最多 12 块；第 13 块创建时先淘汰一块再插入。
 * - 淘汰按「打开次数升序、创建时间升序」取第一块。
 * - 置顶的、刚创建（10 分钟）的、最近编辑/进入过（10 分钟）的都不参与。
 * - 登录用户软删进回收站；游客没有回收站，物理删除。
 *
 * 作用域只覆盖**创建者自己的板**：
 * 团队空间里别人的板不参与淘汰，避免编辑者新建一块就把同事的板删掉。
 * 12 块全部被保护时不做任何删除，返回 429 让用户自己整理。
 *
 * 容量数字只有一处权威来源（`@whiteboard/shared` 的 `BOARD_CAPACITY`），这里只做转出。
 */

export const BOARD_CAPACITY = SHARED_BOARD_CAPACITY;

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

/**
 * 全部可淘汰候选，按「打开次数升序 → 创建时间升序 → id」排好。
 * 空数组表示这些板全在保护期（恢复时据此返回 CAPACITY_NO_EVICTABLE）。
 */
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
 * - none    还没满 12，不需要淘汰；
 * - evicted 已删除并写好审计；
 * - blocked 已满 12 但全部被保护，调用方应返回 429，不能删任何一块。
 */
export type EvictionOutcome =
  | { kind: 'none' }
  | { kind: 'evicted'; board: EvictionResult }
  | { kind: 'blocked' };

/** 恢复时由用户指定被淘汰的板：不区分「不在作用域」与「受保护」就无法给出准确错误码 */
export type SpecificEvictionOutcome =
  | { kind: 'evicted'; board: EvictionResult }
  | { kind: 'not-found' }
  | { kind: 'protected' };

/** 审计里的触发来源：新建第 13 块，还是回收站恢复时的确认式替换 */
export type EvictionTrigger = 'create' | 'restore';

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

function pinnedOf(scope: EvictionScope): ReadonlySet<string> | undefined {
  return scope.kind === 'guest' ? new Set(scope.pinnedIds) : undefined;
}

/** 只读查询用：池子与事务客户端都满足 */
type Queryable = Pick<PoolClient, 'query'>;

/** 读取作用域内全部未归档的板（可加行锁），供创建/恢复两条路径共用。 */
export async function loadScopeBoards(
  client: Queryable,
  scope: EvictionScope,
  { forUpdate = false }: { forUpdate?: boolean } = {},
): Promise<EvictionCandidate[]> {
  const lock = forUpdate ? ' for update' : '';
  const { rows } = scope.kind === 'user'
    ? await client.query<EvictionRow>(
        `select ${SELECT_COLUMNS}
           from boards
          where space_id = $1 and owner_id = $2
            and deleted_at is null and archived_at is null
          order by id${lock}`,
        [scope.spaceId, scope.userId],
      )
    : await client.query<EvictionRow>(
        `select ${SELECT_COLUMNS}
           from boards
          where owner_guest_id = $1
            and deleted_at is null and archived_at is null
          order by id${lock}`,
        [scope.guestId],
      );
  return rows.map(toCandidate);
}

/** 删除 + 审计 + 日志：创建触发的自动淘汰与恢复触发的指定淘汰共用。 */
async function removeBoard(
  client: PoolClient,
  scope: EvictionScope,
  chosen: EvictionCandidate,
  trigger: EvictionTrigger,
  triggerBoardId: string,
): Promise<EvictionResult> {
  if (scope.mode === 'trash') {
    await client.query('update boards set deleted_at = now() where id = $1 and deleted_at is null', [chosen.id]);
  } else {
    // 游客没有回收站：与现有游客删除语义一致，直接物理删除
    await client.query('delete from boards where id = $1 and owner_guest_id = $2', [chosen.id, scope.guestId]);
  }

  await client.query(
    `insert into board_evictions
       (board_id, board_title, owner_id, owner_guest_id, space_id, trigger_board_id,
        policy, opened_count, last_opened_at, board_created_at, mode, trigger)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
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
      trigger,
    ],
  );

  console.info('[boards] capacity eviction', {
    boardId: chosen.id,
    title: chosen.title,
    ownerId: scope.kind === 'user' ? scope.userId : null,
    guestId: scope.kind === 'guest' ? scope.guestId : null,
    spaceId: scope.kind === 'user' ? scope.spaceId : null,
    triggerBoardId,
    trigger,
    policy: EVICTION_POLICY,
    openedCount: chosen.openedCount,
    createdAt: chosen.createdAt.toISOString(),
    mode: scope.mode,
  });

  return {
    id: chosen.id,
    title: chosen.title,
    openedCount: chosen.openedCount,
    lastOpenedAt: chosen.lastOpenedAt,
    createdAt: chosen.createdAt,
    mode: scope.mode,
  };
}

/**
 * 在调用方的事务里执行「满 12 就淘汰一块」。
 *
 * 调用方必须先拿 `pg_advisory_xact_lock`（按 owner 维度），否则并发创建会基于
 * 过期计数同时挑中同一块板，或各自淘汰一块。
 *
 * 返回 `none` 表示还没满 12；`evicted` 表示已删除并写好审计；
 * `blocked` 表示满 12 但没有可淘汰的板，调用方返回 429。
 */
export async function evictForCapacity(
  client: PoolClient,
  scope: EvictionScope,
  triggerBoardId: string,
  trigger: EvictionTrigger = 'create',
): Promise<EvictionOutcome> {
  const candidates = await loadScopeBoards(client, scope, { forUpdate: true });
  if (candidates.length < BOARD_CAPACITY) return { kind: 'none' };

  const chosen = pickEvictionCandidate(candidates, { pinnedIds: pinnedOf(scope) });
  if (!chosen) return { kind: 'blocked' };

  return { kind: 'evicted', board: await removeBoard(client, scope, chosen, trigger, triggerBoardId) };
}

/**
 * 淘汰用户指定的那一块（恢复时的确认式替换）。
 *
 * 只认作用域内、未删除、且仍在可淘汰范围内的板：
 * 置顶 / 10 分钟内创建或编辑过的一律拒绝，避免用户误删正在用的板。
 */
export async function evictSpecificBoard(
  client: PoolClient,
  scope: EvictionScope,
  boardId: string,
  triggerBoardId: string,
): Promise<SpecificEvictionOutcome> {
  const candidates = await loadScopeBoards(client, scope, { forUpdate: true });
  const target = candidates.find((row) => row.id === boardId);
  if (!target) return { kind: 'not-found' };
  if (!isEvictionEligible(target, { pinnedIds: pinnedOf(scope) })) return { kind: 'protected' };

  return { kind: 'evicted', board: await removeBoard(client, scope, target, 'restore', triggerBoardId) };
}
