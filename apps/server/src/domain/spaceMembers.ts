import type { PoolClient } from 'pg';
import type { SpaceRole } from '@whiteboard/shared';
import { pool } from '../infra/db.js';
import { logger } from '../infra/logger.js';
import { memberNotifier } from '../realtime/memberEvents.js';
import { memberIdentityOf } from './boardMembers.js';

/**
 * 空间成员写操作（§7.1.6 成员管理）。
 *
 * 规则：
 * - 只有所有者能调整；个人空间没有「成员管理」语义；
 * - 角色只在 `editor ↔ viewer` 之间调整，所有者身份只能走「转让」；
 * - 不能操作自己（所有者降级自己会留下无主空间）；
 * - 库里的变更立即生效（`resolveSpaceAccess` 每次读库），实时层再补一帧通知，
 *   让已连接的白板连接同步换角色、被移除者立刻断开。
 *
 * 实时通知失败不能让 REST 失败：库里已生效，最坏等下一次 join/重连。
 */

export type SpaceMemberRole = 'editor' | 'viewer';

export type SpaceMemberMutationResult =
  | { status: 'ok'; changed: boolean }
  | { status: 'space_not_found' }
  | { status: 'forbidden' }
  | { status: 'personal' }
  | { status: 'target_not_found' }
  | { status: 'target_owner' }
  | { status: 'self' };

export type SpaceMemberRemovalResult =
  | { status: 'ok'; boardsKept: number }
  | { status: 'space_not_found' }
  | { status: 'forbidden' }
  | { status: 'personal' }
  | { status: 'target_not_found' }
  | { status: 'target_owner' }
  | { status: 'self' };

type LockedSpace = { kind: 'personal' | 'team'; role: SpaceRole };

/** 事务内锁住空间与调用者的成员行；null 统一按「空间不存在」处理。 */
async function lockSpaceMembership(
  client: PoolClient,
  spaceId: string,
  userId: string,
): Promise<LockedSpace | null> {
  const { rows } = await client.query<LockedSpace>(
    `select s.kind, m.role
       from spaces s
       join space_members m on m.space_id = s.id and m.user_id = $2
      where s.id = $1 and s.deleted_at is null
      for update of s, m`,
    [spaceId, userId],
  );
  return rows[0] ?? null;
}

/** 该空间的全部未删除白板（含归档板：归档板仍可打开，权限同样要跟着变）。 */
async function spaceBoardIds(spaceId: string): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    'select id from boards where space_id = $1 and deleted_at is null',
    [spaceId],
  );
  return rows.map((row) => row.id);
}

/** 在该空间所有未删除白板上执行（含归档板）。 */
async function forEachSpaceBoard(
  spaceId: string,
  fn: (boardId: string) => Promise<void>,
): Promise<void> {
  for (const boardId of await spaceBoardIds(spaceId)) {
    try {
      await fn(boardId);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), spaceId, boardId },
        'space member notify failed',
      );
    }
  }
}

/** 把角色变更推到该用户在这个空间里所有在线白板连接上（跨实例）。 */
async function notifySpaceRole(spaceId: string, userId: string, role: SpaceMemberRole): Promise<void> {
  const notifier = memberNotifier();
  if (!notifier) return;
  const identity = memberIdentityOf(userId);
  await forEachSpaceBoard(spaceId, (boardId) => notifier.roleChanged(boardId, identity, role));
}

/** 移除成员后：断开其在该空间所有白板上的连接，并告知「已被移出空间」。 */
async function notifySpaceRemoval(spaceId: string, userId: string): Promise<void> {
  const notifier = memberNotifier();
  if (!notifier) return;
  const identity = memberIdentityOf(userId);
  await forEachSpaceBoard(spaceId, (boardId) => notifier.removed(boardId, identity, 'space'));
}

/** 调整空间成员角色（editor ↔ viewer）。 */
export async function setSpaceMemberRole(
  spaceId: string,
  actorId: string,
  targetId: string,
  role: SpaceMemberRole,
): Promise<SpaceMemberMutationResult> {
  const client = await pool.connect();
  let changed = false;
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`space:${spaceId}`]);

    const space = await lockSpaceMembership(client, spaceId, actorId);
    if (!space) {
      await client.query('rollback');
      return { status: 'space_not_found' };
    }
    if (space.kind === 'personal') {
      await client.query('rollback');
      return { status: 'personal' };
    }
    if (space.role !== 'owner') {
      await client.query('rollback');
      return { status: 'forbidden' };
    }
    if (actorId === targetId) {
      await client.query('rollback');
      return { status: 'self' };
    }

    const { rows } = await client.query<{ role: SpaceRole }>(
      'select role from space_members where space_id = $1 and user_id = $2 for update',
      [spaceId, targetId],
    );
    const target = rows[0];
    if (!target) {
      await client.query('rollback');
      return { status: 'target_not_found' };
    }
    if (target.role === 'owner') {
      await client.query('rollback');
      return { status: 'target_owner' };
    }

    changed = target.role !== role;
    if (changed) {
      await client.query('update space_members set role = $3 where space_id = $1 and user_id = $2', [
        spaceId,
        targetId,
        role,
      ]);
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  if (changed) await notifySpaceRole(spaceId, targetId, role);
  return { status: 'ok', changed };
}

/**
 * 移除空间成员（§13.6）。
 *
 * 口径：
 * - 只有所有者能移除，不能移除自己或所有者；
 * - 其创建的白板**保留在空间**（与「退出空间」一致），返回 `boardsKept` 供前端提示；
 * - 同时吊销其创建的有效邀请链接，避免被移除者用旧链接绕回；
 * - 库里删除后立即断开其在该空间所有白板上的连接。
 */
export async function removeSpaceMember(
  spaceId: string,
  actorId: string,
  targetId: string,
): Promise<SpaceMemberRemovalResult> {
  const client = await pool.connect();
  let boardsKept = 0;
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`space:${spaceId}`]);

    const space = await lockSpaceMembership(client, spaceId, actorId);
    if (!space) {
      await client.query('rollback');
      return { status: 'space_not_found' };
    }
    if (space.kind === 'personal') {
      await client.query('rollback');
      return { status: 'personal' };
    }
    if (space.role !== 'owner') {
      await client.query('rollback');
      return { status: 'forbidden' };
    }
    if (actorId === targetId) {
      await client.query('rollback');
      return { status: 'self' };
    }

    const { rows } = await client.query<{ role: SpaceRole }>(
      'select role from space_members where space_id = $1 and user_id = $2 for update',
      [spaceId, targetId],
    );
    const target = rows[0];
    if (!target) {
      await client.query('rollback');
      return { status: 'target_not_found' };
    }
    if (target.role === 'owner') {
      await client.query('rollback');
      return { status: 'target_owner' };
    }

    const { rows: keptRows } = await client.query<{ count: string }>(
      'select count(*)::text as count from boards where space_id = $1 and owner_id = $2 and deleted_at is null',
      [spaceId, targetId],
    );
    boardsKept = Number(keptRows[0]?.count ?? 0);

    await client.query('delete from space_members where space_id = $1 and user_id = $2', [spaceId, targetId]);
    await client.query(
      'update space_invites set revoked_at = now() where space_id = $1 and created_by = $2 and revoked_at is null',
      [spaceId, targetId],
    );
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  await notifySpaceRemoval(spaceId, targetId);
  return { status: 'ok', boardsKept };
}
