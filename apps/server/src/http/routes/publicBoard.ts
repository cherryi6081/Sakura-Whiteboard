import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { PUBLIC_BOARD_ID } from '@whiteboard/shared';
import { AppError } from '../middlewares/error.js';
import { ensurePublicBoard, resetPublicBoard } from '../../domain/publicBoard.js';
import { getBoardForJoin } from '../../realtime/opStore.js';

/**
 * 公共临时板接口。
 *
 * - `GET /api/public-board`：返回固定 id/标题，前端游客视图用它渲染唯一一张卡片。
 * - `POST /api/public-board/reset`：清空公共板内容。
 *
 * 清空是破坏性操作，且任何人（含匿名访客）都能触发，因此服务端要求请求体显式
 * `{ confirm: true }`（前端还要经过二次确认弹窗），缺省一律 400，避免手滑或误调用。
 * 清空不删板、不删审计：只按正常 LWW 追加 delete op，详见 `domain/publicBoard.ts`。
 */

export const publicBoardRouter = Router();

const handle =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

const resetSchema = z.object({ confirm: z.literal(true) });

publicBoardRouter.get(
  '/public-board',
  handle(async (_req, res) => {
    const board = await ensurePublicBoard();
    res.json(board);
  }),
);

publicBoardRouter.post(
  '/public-board/reset',
  handle(async (req, res) => {
    const parsed = resetSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError(400, 'CONFIRM_REQUIRED', '清空公共临时板需要显式确认（confirm: true）');
    }
    const board = await getBoardForJoin(PUBLIC_BOARD_ID);
    if (!board || board.archived_at || board.deleted_at) throw new AppError(404, 'NOT_FOUND', 'board not found');
    const result = await resetPublicBoard();
    res.json({ boardId: PUBLIC_BOARD_ID, cleared: result.cleared });
  }),
);
