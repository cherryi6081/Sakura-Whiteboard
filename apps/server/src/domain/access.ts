import type { Identity } from '../auth/identity.js';
import { pool } from '../infra/db.js';
import { getBoardForJoin, type BoardRow } from '../realtime/opStore.js';
import { resolveShareToken } from './shareLinks.js';
import { resolveSpaceRole } from './spaceAccess.js';

/**
 * 统一的服务端授权（开发文档 §4.5.2 / §7.1.6）。
 *
 * **身份来源只有 `Identity`**（签名 cookie + Redis 会话），调用方不得再传客户端自报的
 * `guestId` / `role`。规则：
 *
 * 1. 板不存在 / 已归档 / 已在回收站 → `not_found`（软删除后分享链接与协作者一律失效）；
 * 2. **归入空间的板**：角色取 `space_members`（owner / editor / viewer），
 *    `boards.owner_id` 不再直接等于 owner —— 编辑者创建的板在空间里仍是 editor；
 * 3. 无空间的旧板：会话用户是 `owner_id` → `owner`；
 * 4. **无会话**且签名游客是 `owner_guest_id` → `owner`（有会话时 `guestId` 不参与权限）；
 * 5. 会话用户是 `board_members` 成员 → `editor` / `viewer`（成员角色优先于分享链接，不借链接提权）；
 * 6. 其余**必须持有效分享 token**（M5-2 起）：`permission=edit` → `editor`，`read` → `viewer`；
 *    token 校验覆盖过期 / 吊销 / 板不匹配，`share_mode` 不再单独授予任何访问权；
 * 7. `private` 板对陌生人 → `forbidden`（REST 侧统一映射成 404，不暴露存在性）。
 */

export type AccessRole = 'owner' | 'editor' | 'viewer';
export type AccessResult =
  | { ok: true; board: BoardRow; role: AccessRole }
  | { ok: false; reason: 'not_found' | 'forbidden' };

export async function resolveBoardAccess(
  boardId: string,
  identity: Identity,
  shareToken?: string | null,
): Promise<AccessResult> {
  const board = await getBoardForJoin(boardId);
  if (!board || board.archived_at || board.deleted_at) return { ok: false, reason: 'not_found' };

  // 空间成员优先：这是团队白板的唯一权限来源
  if (board.space_id && identity.userId) {
    const role = await resolveSpaceRole(board.space_id, identity.userId);
    if (role) return { ok: true, board, role };
  }

  if (!board.space_id && identity.userId && board.owner_id === identity.userId) {
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

  const permission = await resolveShareToken(boardId, shareToken);
  if (permission === 'edit') return { ok: true, board, role: 'editor' };
  if (permission === 'read') return { ok: true, board, role: 'viewer' };
  return { ok: false, reason: 'forbidden' };
}
