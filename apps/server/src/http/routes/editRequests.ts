import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { AppError } from '../middlewares/error.js';
import { boardIdSchema } from '../../domain/opPage.js';
import { identityOf } from '../../auth/identity.js';
import { resolveBoardAccess } from '../../domain/access.js';
import { resolveSpaceRole } from '../../domain/spaceAccess.js';
import {
  decideEditRequest,
  latestEditRequestOf,
  listEditRequests,
  submitEditRequest,
} from '../../domain/editRequests.js';
import { requireOwner } from './shares.js';
import { shareTokenOf } from './assets.js';

/**
 * 申请编辑权限 REST。
 *
 * - `POST   /api/boards/:id/edit-requests`        只读访客（登录用户）申请；
 * - `GET    /api/boards/:id/edit-requests/mine`   申请人刷新后恢复状态；
 * - `GET    /api/boards/:id/edit-requests`        owner 查看待处理（`?all=1` 含历史）；
 * - `PATCH  /api/boards/:id/edit-requests/:rid`   owner 批准 / 拒绝。
 *
 * 权限判定全部复用 `resolveBoardAccess` / `requireOwner`，不另建模型；
 * 分享 token 仍只从 `x-share-token` 头（或兼容的 query）读取，不写回 URL。
 */

export const editRequestsRouter = Router();

const handle =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

const noteSchema = z
  .string()
  .trim()
  .max(200)
  .optional()
  .transform((value) => (value ? value : null));

const createSchema = z.object({ note: noteSchema });

const decideSchema = z.object({ status: z.enum(['approved', 'rejected']) });

const requestIdSchema = z.string().uuid();

const listQuerySchema = z.object({
  /** '1' 时连已处理的申请一起返回，便于所有者回看 */
  all: z.enum(['0', '1']).optional(),
});

/** 游客没有可落库的账号身份，申请必须登录。 */
function requireUser(req: Request): string {
  const { userId } = identityOf(req);
  if (!userId) throw new AppError(401, 'UNAUTHENTICATED', '登录后才能申请编辑权限');
  return userId;
}

/** `POST /api/boards/:id/edit-requests` —— 只读访客申请可写权限。 */
editRequestsRouter.post(
  '/boards/:id/edit-requests',
  handle(async (req, res) => {
    const boardId = boardIdSchema.parse(req.params.id);
    const userId = requireUser(req);
    const { note } = createSchema.parse(req.body ?? {});

    const access = await resolveBoardAccess(boardId, identityOf(req), shareTokenOf(req));
    if (!access.ok) throw new AppError(404, 'NOT_FOUND', 'board not found');
    if (access.role !== 'viewer') {
      throw new AppError(409, 'ALREADY_HAS_EDIT', '你已经有这块白板的编辑权限');
    }

    // 空间成员的角色由 space_members 管理，board_members 升级不会生效
    if (access.board.space_id) {
      const spaceRole = await resolveSpaceRole(access.board.space_id, userId);
      if (spaceRole === 'viewer') {
        throw new AppError(
          409,
          'SPACE_ROLE_GOVERNS',
          '你在这个空间里是只读成员，请联系空间所有者调整空间角色',
        );
      }
    }

    const { request, inserted } = await submitEditRequest(boardId, userId, note);
    res.status(inserted ? 201 : 200).json({ request });
  }),
);

/** `GET /api/boards/:id/edit-requests/mine` —— 当前用户最近一条申请（含处理结果）。 */
editRequestsRouter.get(
  '/boards/:id/edit-requests/mine',
  handle(async (req, res) => {
    const boardId = boardIdSchema.parse(req.params.id);
    const userId = requireUser(req);

    const access = await resolveBoardAccess(boardId, identityOf(req), shareTokenOf(req));
    if (!access.ok) throw new AppError(404, 'NOT_FOUND', 'board not found');

    res.json({ request: await latestEditRequestOf(boardId, userId), role: access.role });
  }),
);

/** `GET /api/boards/:id/edit-requests` —— 所有者查看申请列表。 */
editRequestsRouter.get(
  '/boards/:id/edit-requests',
  handle(async (req, res) => {
    const boardId = boardIdSchema.parse(req.params.id);
    const { all } = listQuerySchema.parse(req.query);
    await requireOwner(req, boardId, '查看编辑申请');

    res.json({ boardId, requests: await listEditRequests(boardId, all === '1') });
  }),
);

/** `PATCH /api/boards/:id/edit-requests/:requestId` —— 批准 / 拒绝。 */
editRequestsRouter.patch(
  '/boards/:id/edit-requests/:requestId',
  handle(async (req, res) => {
    const boardId = boardIdSchema.parse(req.params.id);
    const requestId = requestIdSchema.parse(req.params.requestId);
    const { status } = decideSchema.parse(req.body ?? {});
    const approverId = requireUser(req);
    await requireOwner(req, boardId, '处理编辑申请');

    const result = await decideEditRequest(boardId, requestId, approverId, status);
    if (result.status === 'not_found') throw new AppError(404, 'NOT_FOUND', '申请不存在');
    if (result.status === 'already_decided') {
      throw new AppError(409, 'ALREADY_DECIDED', '这条申请已经处理过了');
    }
    if (result.status === 'space_role_governs') {
      throw new AppError(
        409,
        'SPACE_ROLE_GOVERNS',
        '申请人是空间只读成员，请在空间设置里调整其角色',
      );
    }

    res.json({ request: result.request, granted: result.granted });
  }),
);
