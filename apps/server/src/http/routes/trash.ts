import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { pool } from '../../infra/db.js';
import { AppError } from '../middlewares/error.js';
import { boardIdSchema } from '../../domain/opPage.js';
import { identityOf } from '../../auth/identity.js';
import { uniqueBoardTitle } from '../../domain/boardTitle.js';
import { TRASH_RETENTION_DAYS } from '../../domain/retention.js';

/**
 * 回收站（「我的白板」v1.2 第 1 步）。
 *
 * - 只服务登录用户的**个人板**：回收站跟随白板归属，协作者删除不会产生条目；
 * - 软删除只写 `deleted_at`，`resolveBoardAccess` 立即视为 404（分享链接与协作同时失效）；
 * - 恢复复用原 board id；同空间同名时自动追加「（2）」，由 `uniqueBoardTitle` 决定；
 * - 彻底删除 / 清空是物理删除，级联 board_members / board_ops / elements / assets；
 * - 游客板删除即删（设计稿 §07：临时板没有回收站）。
 *
 * 路径顺序有要求：`/boards/trash*` 必须挂在 `boardsRouter` 之前，
 * 否则 `DELETE /boards/:id` 会把 `trash` 当成 boardId 解析成 400。
 */

export const trashRouter = Router();

const handle =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

const trashQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(12),
  offset: z.coerce.number().int().min(0).default(0),
  /** `expiring` = 只剩 ≤ 7 天，对应设计稿的「7 天内到期」筛选 */
  filter: z.enum(['all', 'expiring']).default('all'),
});

type TrashRow = {
  id: string;
  title: string;
  deleted_at: Date;
  purge_at: Date;
};

function toTrashItem(row: TrashRow) {
  return {
    id: row.id,
    title: row.title,
    // 空间功能落地前统一归入个人空间；第 5 步改为真实 space 名
    spaceName: null,
    deletedAt: row.deleted_at.toISOString(),
    purgeAt: row.purge_at.toISOString(),
  };
}

/** `GET /api/boards/trash` —— 个人回收站，按删除时间倒序，12 行一页。 */
trashRouter.get(
  '/boards/trash',
  handle(async (req, res) => {
    const identity = identityOf(req);
    if (!identity.userId) throw new AppError(401, 'UNAUTHENTICATED', '请先登录');
    const { limit, offset, filter } = trashQuerySchema.parse(req.query);

    const { rows } = await pool.query<TrashRow>(
      `select id, title, deleted_at,
              deleted_at + make_interval(days => $3::int) as purge_at
         from boards
        where owner_id = $1 and deleted_at is not null
          and ($5 = 'all' or deleted_at <= now() - make_interval(days => $3::int - 7))
        order by deleted_at desc, id desc
        limit $2 offset $4`,
      [identity.userId, limit + 1, TRASH_RETENTION_DAYS, offset, filter],
    );

    const pageRows = rows.slice(0, limit);
    const { rows: countRows } = await pool.query<{ all_total: number; expiring_soon: number; filtered: number }>(
      `select count(*)::int as all_total,
              count(*) filter (where deleted_at <= now() - make_interval(days => $2::int - 7))::int as expiring_soon,
              count(*) filter (where $3 = 'all' or deleted_at <= now() - make_interval(days => $2::int - 7))::int as filtered
         from boards
        where owner_id = $1 and deleted_at is not null`,
      [identity.userId, TRASH_RETENTION_DAYS, filter],
    );

    res.json({
      boards: pageRows.map(toTrashItem),
      total: countRows[0]?.filtered ?? 0,
      allTotal: countRows[0]?.all_total ?? 0,
      expiringSoon: countRows[0]?.expiring_soon ?? 0,
      nextOffset: rows.length > limit ? offset + limit : null,
    });
  }),
);

/** `GET /api/boards/trash/count` —— 顶栏徽标只需要一个数，不拉整页。 */
trashRouter.get(
  '/boards/trash/count',
  handle(async (req, res) => {
    const identity = identityOf(req);
    if (!identity.userId) throw new AppError(401, 'UNAUTHENTICATED', '请先登录');
    const { rows } = await pool.query<{ total: number }>(
      'select count(*)::int as total from boards where owner_id = $1 and deleted_at is not null',
      [identity.userId],
    );
    res.json({ count: rows[0]?.total ?? 0 });
  }),
);

/** `DELETE /api/boards/trash` —— 清空回收站（物理删除全部已删除板）。 */
trashRouter.delete(
  '/boards/trash',
  handle(async (req, res) => {
    const identity = identityOf(req);
    if (!identity.userId) throw new AppError(401, 'UNAUTHENTICATED', '请先登录');
    const { rowCount } = await pool.query(
      'delete from boards where owner_id = $1 and deleted_at is not null',
      [identity.userId],
    );
    res.json({ purged: rowCount ?? 0 });
  }),
);

/**
 * `DELETE /api/boards/:id` —— 删除。
 *
 * - 登录 owner：软删除，进个人回收站，30 天后由每日任务清理；
 * - 游客 owner：直接物理删除（临时板没有回收站）；
 * - 非 owner：403，协作者的「移出我的列表」在后续步骤落地。
 */
trashRouter.delete(
  '/boards/:id',
  handle(async (req, res) => {
    const boardId = boardIdSchema.parse(req.params.id);
    const identity = identityOf(req);

    if (identity.userId) {
      const { rows } = await pool.query<{ deleted_at: Date; purge_at: Date }>(
        `update boards
            set deleted_at = now()
          where id = $1 and owner_id = $2 and deleted_at is null
          returning deleted_at, deleted_at + make_interval(days => $3::int) as purge_at`,
        [boardId, identity.userId, TRASH_RETENTION_DAYS],
      );
      const row = rows[0];
      if (!row) throw new AppError(404, 'NOT_FOUND', '白板不存在或已经被删除');
      res.json({
        id: boardId,
        mode: 'trash',
        deletedAt: row.deleted_at.toISOString(),
        purgeAt: row.purge_at.toISOString(),
      });
      return;
    }

    if (!identity.guestId) throw new AppError(404, 'NOT_FOUND', '白板不存在或已经被删除');
    const { rowCount } = await pool.query(
      'delete from boards where id = $1 and owner_guest_id = $2 and deleted_at is null',
      [boardId, identity.guestId],
    );
    if (!rowCount) throw new AppError(404, 'NOT_FOUND', '白板不存在或已经被删除');
    res.json({ id: boardId, mode: 'purged', deletedAt: null, purgeAt: null });
  }),
);

/** `POST /api/boards/:id/restore` —— 从回收站恢复；同名自动加序号。 */
trashRouter.post(
  '/boards/:id/restore',
  handle(async (req, res) => {
    const boardId = boardIdSchema.parse(req.params.id);
    const identity = identityOf(req);
    if (!identity.userId) throw new AppError(401, 'UNAUTHENTICATED', '请先登录');

    const { rows } = await pool.query<{ id: string; title: string }>(
      'select id, title from boards where id = $1 and owner_id = $2 and deleted_at is not null',
      [boardId, identity.userId],
    );
    const board = rows[0];
    if (!board) throw new AppError(404, 'NOT_FOUND', '回收站里没有这块白板');

    const { rows: takenRows } = await pool.query<{ title: string }>(
      'select title from boards where owner_id = $1 and deleted_at is null and id <> $2',
      [identity.userId, boardId],
    );
    const title = uniqueBoardTitle(
      board.title,
      takenRows.map((row) => row.title),
    );

    await pool.query(
      'update boards set deleted_at = null, title = $2 where id = $1 and owner_id = $3',
      [boardId, title, identity.userId],
    );

    res.json({ id: boardId, title, renamed: title !== board.title, deletedAt: null });
  }),
);

/** `DELETE /api/boards/:id/purge` —— 彻底删除单块（只接受已在回收站的板）。 */
trashRouter.delete(
  '/boards/:id/purge',
  handle(async (req, res) => {
    const boardId = boardIdSchema.parse(req.params.id);
    const identity = identityOf(req);
    if (!identity.userId) throw new AppError(401, 'UNAUTHENTICATED', '请先登录');

    const { rowCount } = await pool.query(
      'delete from boards where id = $1 and owner_id = $2 and deleted_at is not null',
      [boardId, identity.userId],
    );
    if (!rowCount) throw new AppError(404, 'NOT_FOUND', '回收站里没有这块白板');
    res.json({ id: boardId, purged: true });
  }),
);
