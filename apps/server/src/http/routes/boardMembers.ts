import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { pool } from '../../infra/db.js';
import { AppError } from '../middlewares/error.js';
import { boardIdSchema } from '../../domain/opPage.js';
import { identityOf } from '../../auth/identity.js';
import {
  addBoardMember,
  removeBoardMember,
  setBoardMemberRole,
  type BoardMemberRole,
} from '../../domain/boardMembers.js';
import { requireOwner } from './shares.js';

/**
 * 白板级成员管理（development §协作与实时）。
 *
 * 只有 **owner** 能管理，复用 `board_members`（权限判定仍走 `resolveBoardAccess`）：
 * - `GET`    列表：所有者 + 直接协作者；空间成员不在这里（空间权限在空间设置里管）。
 * - `POST`   按邮箱添加已注册用户；对方若正用分享链接在线，会就地升级角色。
 * - `PATCH`  改角色（editor/viewer）；在线连接立即生效，已提交的 op 不回滚。
 * - `DELETE` 移出：删成员行 + 断开该用户在该板的全部 socket；不封禁，可重新邀请。
 *
 * 游客世界观：游客不是 `board_members` 成员（只有 `boards.owner_guest_id` 一种归属），
 * 因此成员接口只接受登录用户的 userId。
 */

export const boardMembersRouter = Router();

const handle =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

const roleSchema = z.enum(['editor', 'viewer']);
const userIdSchema = z.string().uuid();

const addMemberSchema = z.object({
  /** 只能邀请已注册用户；未注册时明确报 404，不创建"影子成员" */
  email: z.string().trim().email().max(254),
  role: roleSchema.default('editor'),
});

const patchMemberSchema = z.object({ role: roleSchema });

/** `GET /api/boards/:id/members` —— 所有者列出白板成员（含自己）。 */
boardMembersRouter.get(
  '/boards/:id/members',
  handle(async (req, res) => {
    const boardId = boardIdSchema.parse(req.params.id);
    await requireOwner(req, boardId);

    const [boardRes, memberRes] = await Promise.all([
      pool.query<{ owner_id: string | null; owner_guest_id: string | null }>(
        'select owner_id, owner_guest_id from boards where id = $1',
        [boardId],
      ),
      pool.query<{
        user_id: string;
        role: BoardMemberRole;
        created_at: Date;
        display_name: string;
        email: string | null;
        avatar_url: string | null;
      }>(
        `select m.user_id, m.role, m.created_at, u.display_name, u.email, u.avatar_url
           from board_members m
           join users u on u.id = m.user_id
          where m.board_id = $1
          order by m.created_at asc`,
        [boardId],
      ),
    ]);

    const ownerId = boardRes.rows[0]?.owner_id ?? null;
    let ownerRow: { display_name: string; email: string | null; avatar_url: string | null } | null = null;
    if (ownerId) {
      const { rows } = await pool.query<{ display_name: string; email: string | null; avatar_url: string | null }>(
        'select display_name, email, avatar_url from users where id = $1',
        [ownerId],
      );
      ownerRow = rows[0] ?? null;
    }

    res.json({
      boardId,
      members: [
        // 所有者由 boards.owner_id 表达，不重复存 board_members；列表里补一行方便前端渲染
        {
          userId: ownerId,
          role: 'owner' as const,
          displayName: ownerRow?.display_name ?? (ownerId ? '所有者' : '游客所有者'),
          email: ownerRow?.email ?? null,
          avatarUrl: ownerRow?.avatar_url ?? null,
          joinedAt: null,
        },
        ...memberRes.rows.map((row) => ({
          userId: row.user_id,
          role: row.role,
          displayName: row.display_name,
          email: row.email,
          avatarUrl: row.avatar_url,
          joinedAt: row.created_at.toISOString(),
        })),
      ],
    });
  }),
);

/** `POST /api/boards/:id/members` —— 按邮箱添加协作者。 */
boardMembersRouter.post(
  '/boards/:id/members',
  handle(async (req, res) => {
    const boardId = boardIdSchema.parse(req.params.id);
    const { email, role } = addMemberSchema.parse(req.body ?? {});
    await requireOwner(req, boardId);

    const { rows } = await pool.query<{ id: string }>(
      `select id from users where email = $1 and status = 'active'`,
      [email],
    );
    const target = rows[0];
    if (!target) throw new AppError(404, 'NOT_FOUND', '该邮箱尚未注册');

    const { rows: boardRows } = await pool.query<{ owner_id: string | null }>(
      'select owner_id from boards where id = $1',
      [boardId],
    );
    if (boardRows[0]?.owner_id === target.id) {
      throw new AppError(400, 'INVALID_INPUT', '所有者无需添加为协作者');
    }

    const identity = identityOf(req);
    const result = await addBoardMember(boardId, target.id, role, identity.userId);
    res.status(result === 'unchanged' ? 200 : 201).json({ userId: target.id, role });
  }),
);

/** `PATCH /api/boards/:id/members/:userId` —— 改协作者角色。 */
boardMembersRouter.patch(
  '/boards/:id/members/:userId',
  handle(async (req, res) => {
    const boardId = boardIdSchema.parse(req.params.id);
    const userId = userIdSchema.parse(req.params.userId);
    const { role } = patchMemberSchema.parse(req.body ?? {});
    await requireOwner(req, boardId);

    const result = await setBoardMemberRole(boardId, userId, role);
    if (result === 'not_found') throw new AppError(404, 'NOT_FOUND', '该用户不是这块白板的协作者');
    res.json({ userId, role });
  }),
);

/** `DELETE /api/boards/:id/members/:userId` —— 移出协作者并断开其在该板的连接。 */
boardMembersRouter.delete(
  '/boards/:id/members/:userId',
  handle(async (req, res) => {
    const boardId = boardIdSchema.parse(req.params.id);
    const userId = userIdSchema.parse(req.params.userId);
    await requireOwner(req, boardId);

    const removed = await removeBoardMember(boardId, userId);
    if (!removed) throw new AppError(404, 'NOT_FOUND', '该用户不是这块白板的协作者');
    res.status(204).end();
  }),
);
