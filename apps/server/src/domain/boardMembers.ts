import { pool } from '../infra/db.js';
import { logger } from '../infra/logger.js';
import { memberNotifier } from '../realtime/memberEvents.js';

/**
 * 白板级成员（`board_members`）的写操作 + 实时通知。
 *
 * 权限判定仍以 `domain/access.ts` 为准（成员角色 → editor/viewer）；这里只负责把
 * 变更写进库，并让在线连接**立即**感知：
 * - 角色变更：在线连接就地换角色（已提交的 op 不回滚）；
 * - 移出：删成员行 + 断开该用户在该板的全部 socket，**不封禁**（可重新邀请）。
 *
 * 游客不在 `board_members` 里（游客只有 `boards.owner_guest_id` 一种归属），
 * 因此移出接口对游客无意义，路由层按 userId 校验。
 */

export type BoardMemberRole = 'editor' | 'viewer';
export type MemberMutationResult = 'ok' | 'unchanged' | 'not_found';

/** presence / socket.data 里的用户身份口径 */
export const memberIdentityOf = (userId: string): string => `user:${userId}`;

/**
 * 变更成员角色。目标不是成员时返回 `not_found`；角色相同则不通知（避免无意义广播）。
 */
export async function setBoardMemberRole(
  boardId: string,
  userId: string,
  role: BoardMemberRole,
): Promise<MemberMutationResult> {
  const { rows } = await pool.query<{ role: BoardMemberRole }>(
    'select role from board_members where board_id = $1 and user_id = $2',
    [boardId, userId],
  );
  const existing = rows[0];
  if (!existing) return 'not_found';
  if (existing.role === role) return 'unchanged';

  await pool.query('update board_members set role = $3 where board_id = $1 and user_id = $2', [boardId, userId, role]);
  await notify(() => memberNotifier()?.roleChanged(boardId, memberIdentityOf(userId), role), 'roleChanged', boardId, userId);
  return 'ok';
}

/**
 * 添加成员：已是成员时退化为角色变更（同角色不重复通知）。
 * 新成员可能正在以分享链接的只读身份在线，这里同样要通知——连接会就地升级为 editor。
 */
export async function addBoardMember(
  boardId: string,
  userId: string,
  role: BoardMemberRole,
  addedBy: string | null,
): Promise<MemberMutationResult> {
  const { rows } = await pool.query<{ role: BoardMemberRole }>(
    'select role from board_members where board_id = $1 and user_id = $2',
    [boardId, userId],
  );
  const existing = rows[0];
  if (existing) {
    if (existing.role === role) return 'unchanged';
    return setBoardMemberRole(boardId, userId, role);
  }

  await pool.query(
    `insert into board_members (board_id, user_id, role, added_by)
     values ($1, $2, $3, $4)
     on conflict (board_id, user_id) do update set role = excluded.role`,
    [boardId, userId, role, addedBy],
  );
  await notify(() => memberNotifier()?.roleChanged(boardId, memberIdentityOf(userId), role), 'roleChanged', boardId, userId);
  return 'ok';
}

/**
 * 移出成员：先删行再断开。返回 false 表示目标本来就不是成员。
 * 断开后该用户仍可凭分享链接或被重新邀请再进来（不做封禁）。
 */
export async function removeBoardMember(boardId: string, userId: string): Promise<boolean> {
  const { rowCount } = await pool.query('delete from board_members where board_id = $1 and user_id = $2', [boardId, userId]);
  if (!rowCount) return false;
  await notify(() => memberNotifier()?.removed(boardId, memberIdentityOf(userId)), 'removed', boardId, userId);
  return true;
}

/**
 * 实时通知失败不能让 REST 请求失败：库里的变更已经生效，
 * 最坏情况下客户端要等下一次 join/重连才看到新权限。
 */
async function notify(
  run: () => Promise<void> | undefined,
  action: string,
  boardId: string,
  userId: string,
): Promise<void> {
  try {
    await run();
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), action, boardId, userId },
      'member event notify failed',
    );
  }
}
