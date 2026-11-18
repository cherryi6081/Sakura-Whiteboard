import { pool } from '../infra/db.js';
import { logger } from '../infra/logger.js';
import { memberNotifier } from '../realtime/memberEvents.js';
import { memberIdentityOf } from './boardMembers.js';

/**
 * 申请编辑权限（`board_edit_requests`）。
 *
 * 权限判定的唯一来源仍是 `domain/access.ts`：
 * - 申请人必须是「能访问该板但只有 viewer」的登录用户（路由层判定）；
 * - 批准时只写 `board_members(editor)`，在线连接由 `memberNotifier.roleChanged` 就地升级；
 * - 拒绝不改任何权限，只落库状态。
 *
 * 空间成员的角色由 `space_members` 管理，`board_members` 会被覆盖；
 * 因此申请人是空间只读成员时直接返回 `space_role_governs`，避免批准后仍然没有写权限。
 */

export type EditRequestStatus = 'pending' | 'approved' | 'rejected';
export type EditRequestDecision = 'approved' | 'rejected';

export type EditRequest = {
  id: string;
  boardId: string;
  requesterId: string;
  note: string | null;
  status: EditRequestStatus;
  createdAt: string;
  decidedAt: string | null;
};

export type EditRequestSummary = EditRequest & {
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
};

type RequestRow = {
  id: string;
  board_id: string;
  requester_id: string;
  note: string | null;
  status: EditRequestStatus;
  created_at: Date;
  decided_at: Date | null;
};

const toRequest = (row: RequestRow): EditRequest => ({
  id: row.id,
  boardId: row.board_id,
  requesterId: row.requester_id,
  note: row.note,
  status: row.status,
  createdAt: row.created_at.toISOString(),
  decidedAt: row.decided_at ? row.decided_at.toISOString() : null,
});

/**
 * 创建或复用待处理申请。
 * 部分唯一索引 `board_edit_requests_pending_uidx` 保证同一人重复点击只留一条；
 * `inserted` 用于区分新建 / 命中已有待处理记录。
 */
export async function submitEditRequest(
  boardId: string,
  requesterId: string,
  note: string | null,
): Promise<{ request: EditRequest; inserted: boolean }> {
  const { rows } = await pool.query<RequestRow & { inserted: boolean }>(
    `insert into board_edit_requests (board_id, requester_id, note)
     values ($1, $2, $3)
     on conflict (board_id, requester_id) where status = 'pending'
     do update set
       note = coalesce(excluded.note, board_edit_requests.note),
       updated_at = now()
     returning id, board_id, requester_id, note, status, created_at, decided_at, (xmax = 0) as inserted`,
    [boardId, requesterId, note],
  );
  const row = rows[0];
  if (!row) throw new Error('edit request upsert returned no row');
  return { request: toRequest(row), inserted: row.inserted };
}

/** 申请人查看自己最近一条申请（含已处理结果），用于刷新后恢复按钮状态。 */
export async function latestEditRequestOf(boardId: string, requesterId: string): Promise<EditRequest | null> {
  const { rows } = await pool.query<RequestRow>(
    `select id, board_id, requester_id, note, status, created_at, decided_at
       from board_edit_requests
      where board_id = $1 and requester_id = $2
      order by created_at desc
      limit 1`,
    [boardId, requesterId],
  );
  const row = rows[0];
  return row ? toRequest(row) : null;
}

/** 所有者查看申请列表；默认只看 pending，`all=true` 时连历史一起返回（最多 50 条）。 */
export async function listEditRequests(boardId: string, all = false): Promise<EditRequestSummary[]> {
  const statusFilter = all ? '' : `and r.status = 'pending'`;
  const { rows } = await pool.query<
    RequestRow & { display_name: string; email: string | null; avatar_url: string | null }
  >(
    `select r.id, r.board_id, r.requester_id, r.note, r.status, r.created_at, r.decided_at,
            u.display_name, u.email, u.avatar_url
       from board_edit_requests r
       join users u on u.id = r.requester_id
      where r.board_id = $1 ${statusFilter}
      order by r.created_at desc
      limit 50`,
    [boardId],
  );
  return rows.map((row) => ({
    ...toRequest(row),
    displayName: row.display_name,
    email: row.email,
    avatarUrl: row.avatar_url,
  }));
}

export type DecideResult =
  | { status: 'ok'; request: EditRequest; granted: boolean }
  | { status: 'not_found' }
  | { status: 'already_decided'; current: EditRequestStatus }
  | { status: 'space_role_governs' };

/**
 * 批准 / 拒绝。批准与写成员行在同一事务里，之后才发实时通知。
 * 调用方（路由）必须先确认操作者是 owner。
 */
export async function decideEditRequest(
  boardId: string,
  requestId: string,
  approverId: string,
  decision: EditRequestDecision,
): Promise<DecideResult> {
  const client = await pool.connect();
  let requesterId: string | null = null;
  let granted = false;
  try {
    await client.query('begin');
    const { rows } = await client.query<RequestRow>(
      `select id, board_id, requester_id, note, status, created_at, decided_at
         from board_edit_requests
        where id = $1 and board_id = $2
        for update`,
      [requestId, boardId],
    );
    const current = rows[0];
    if (!current) {
      await client.query('rollback');
      return { status: 'not_found' };
    }
    if (current.status !== 'pending') {
      await client.query('rollback');
      return { status: 'already_decided', current: current.status };
    }
    requesterId = current.requester_id;

    if (decision === 'approved') {
      // 空间成员的角色优先于 board_members：空间只读成员批准也不会生效，交给空间所有者调整
      const { rows: spaceRows } = await client.query<{ role: string }>(
        `select m.role
           from boards b
           join space_members m on m.space_id = b.space_id and m.user_id = $2
          where b.id = $1`,
        [boardId, requesterId],
      );
      const spaceRole = spaceRows[0]?.role;
      if (spaceRole === 'viewer') {
        await client.query('rollback');
        return { status: 'space_role_governs' };
      }

      // 空间 editor/owner 本来就有写权限：只落状态，不重复写 board_members
      if (!spaceRole) {
        const { rows: memberRows } = await client.query<{ role: string }>(
          `select role from board_members where board_id = $1 and user_id = $2 for update`,
          [boardId, requesterId],
        );
        const member = memberRows[0];
        if (!member) {
          await client.query(
            `insert into board_members (board_id, user_id, role, added_by)
             values ($1, $2, 'editor', $3)
             on conflict (board_id, user_id) do update set role = 'editor'`,
            [boardId, requesterId, approverId],
          );
          granted = true;
        } else if (member.role !== 'editor') {
          await client.query(`update board_members set role = 'editor' where board_id = $1 and user_id = $2`, [
            boardId,
            requesterId,
          ]);
          granted = true;
        }
      }
    }

    const { rows: updated } = await client.query<RequestRow>(
      `update board_edit_requests
          set status = $3,
              decided_by = $4,
              decided_at = now(),
              updated_at = now()
        where id = $1 and board_id = $2
        returning id, board_id, requester_id, note, status, created_at, decided_at`,
      [requestId, boardId, decision, approverId],
    );
    const row = updated[0];
    if (!row) throw new Error('edit request update returned no row');
    await client.query('commit');

    // 实时升级：批准后让申请人当前打开的连接立即变成 editor（失败不影响请求结果）
    if (granted) {
      try {
        await memberNotifier()?.roleChanged(boardId, memberIdentityOf(requesterId), 'editor');
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), boardId, requesterId },
          'edit request role notify failed',
        );
      }
    }
    return { status: 'ok', request: toRequest(row), granted };
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
