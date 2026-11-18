import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { can, LIMITS } from '@whiteboard/shared';
import { AppError } from '../middlewares/error.js';
import { boardIdSchema } from '../../domain/opPage.js';
import { identityOf } from '../../auth/identity.js';
import { resolveBoardAccess } from '../../domain/access.js';
import { ensurePersonalSpace, resolveSpaceRole } from '../../domain/spaceAccess.js';
import { copyBoardContents } from '../../domain/boardCopy.js';
import { StorageError } from '../../infra/storage.js';
import { shareTokenOf } from './assets.js';

/**
 * `POST /api/boards/:id/copy` —— 复制白板内容到调用者本人名下。
 *
 * - 只要能看到源板就能复制（owner / editor / viewer / 分享链接访客均可），但必须是登录用户；
 * - 目标空间缺省为个人空间；显式 `spaceId` 时要求在该空间有建板权限（owner / editor）；
 * - 只复制元素与图片资产，权限、分享链接、成员不会带过去（见 `domain/boardCopy.ts`）。
 */

export const copyBoardRouter = Router();

const handle =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

const spaceIdSchema = z.string().regex(/^sp_[A-Za-z0-9_-]{10,32}$/);

const copySchema = z.object({
  title: z.string().trim().min(1).max(LIMITS.boardTitleMax).optional(),
  spaceId: spaceIdSchema.optional(),
});

copyBoardRouter.post(
  '/boards/:id/copy',
  handle(async (req, res) => {
    const boardId = boardIdSchema.parse(req.params.id);
    const { title, spaceId } = copySchema.parse(req.body ?? {});
    const identity = identityOf(req);
    if (!identity.userId) throw new AppError(401, 'UNAUTHENTICATED', '登录后才能复制到自己的空间');

    const access = await resolveBoardAccess(boardId, identity, shareTokenOf(req));
    if (!access.ok) throw new AppError(404, 'NOT_FOUND', 'board not found');

    let targetSpaceId: string;
    if (spaceId) {
      const role = await resolveSpaceRole(spaceId, identity.userId);
      if (!role) throw new AppError(404, 'NOT_FOUND', 'space not found');
      if (!can(role, 'createBoard')) throw new AppError(403, 'FORBIDDEN', '只读成员不能把白板复制进这个空间');
      targetSpaceId = spaceId;
    } else {
      targetSpaceId = (await ensurePersonalSpace(identity.userId)).id;
    }

    try {
      const result = await copyBoardContents({
        sourceBoardId: boardId,
        sourceTitle: access.board.title,
        userId: identity.userId,
        spaceId: targetSpaceId,
        title,
      });
      res.status(201).json({
        id: result.boardId,
        title: result.title,
        spaceId: result.spaceId,
        elementCount: result.elementCount,
        assetCount: result.assetCount,
        skippedElements: result.skippedElements,
      });
    } catch (err) {
      if (err instanceof StorageError) {
        throw new AppError(503, 'STORAGE_UNAVAILABLE', '图片存储服务不可用，请稍后重试');
      }
      throw err;
    }
  }),
);
