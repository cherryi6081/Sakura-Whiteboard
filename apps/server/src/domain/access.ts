import type { Identity } from '../auth/identity.js';
import { pool } from '../infra/db.js';
import { getBoardForJoin, type BoardRow } from '../realtime/opStore.js';

/**
 * 统一的服务端授权（开发文档 §4.5.2 / §7.1.6）。
 *
 * **身份来源只有 `Identity`**（签名 cookie + Redis 会话），调用方不得再传客户端自报的
 * `guestId` / `role`。规则：
 *
 * 1. 板不存在 / 已归档 → `not_found`；
 * 2. 会话用户是 `owner_id` → `owner`；
 * 3. **无会话**且签名游客是 `owner_guest_id` → `owner`（有会话时 `guestId` 不参与权限）；
 * 4. 会话用户是 `board_members` 成员 → `editor` / `viewer`（成员角色优先于公开链接，不借链接提权）；
 * 5. 其余按 `share_mode`：`link_edit` → `editor`，`link_read` → `viewer`（M5-1 尚未接 share token，
 *    token 校验在 M5-2 插入这一层）；
 * 6. `private` 板对陌生人 → `forbidden`（REST 侧统一映射成 404，不暴露存在性）。
 */

export type AccessRole = 'owner' | 'editor' | 'viewer';
export type AccessResult =
  | { ok: true; board: BoardRow; role: AccessRole }
  | { ok: false; reason: 'not_found' | 'forbidden' };

export async function resolveBoardAccess(boardId: string, identity: Identity): Promise<AccessResult> {
  const board = await getBoardForJoin(boardId);
  if (!board || board.archived_at) return { ok: false, reason: 'not_found' };

  if (identity.userId && board.owner_id === identity.userId) {
    return { ok: true, board, role: 'owner' };
  }
  if (!identity.userId && identity.guestId && board.owner_guest_id === identity.guestId) {
    return { ok: true, board, role: 'owner' };
  }

  if (identity.userId) {
    const { rows } = await pool.query<{ role: 'editor' | 'viewer' }>(
      'select role from board_members where board_id = $1 and user_id = $2',
      [boardId, identity.userId],
    );
    const member = rows[0];
    if (member) return { ok: true, board, role: member.role };
  }

  if (board.share_mode === 'link_edit') return { ok: true, board, role: 'editor' };
  if (board.share_mode === 'link_read') return { ok: true, board, role: 'viewer' };
  return { ok: false, reason: 'forbidden' };
}
