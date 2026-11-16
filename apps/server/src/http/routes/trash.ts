import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { PoolClient } from 'pg';
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
 * - 登录账号不限白板数量：**恢复不做容量判定**，不会因空间已满被拒，也不会淘汰已有板；
 *   「恢复并替换」只属于游客场景，而游客没有回收站，因此这里不再有该分支；
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
  space_id: string | null;
  space_name: string | null;
  deleted_at: Date;
  purge_at: Date;
};

function toTrashItem(row: TrashRow) {
  return {
    id: row.id,
    title: row.title,
    spaceId: row.space_id,
    spaceName: row.space_name,
    deletedAt: row.deleted_at.toISOString(),
    purgeAt: row.purge_at.toISOString(),
  };
}

/**
 * 回收站可见范围：当前仍在该空间的成员，才能看到自己创建的板；空间所有者能看到空间里的所有板。
 * - 个人空间：成员只有自己，按「自己创建的板」可见；
 * - 团队空间：退出后不再是成员，连带自己创建的板也不再出现在回收站（板留在空间里归空间管理）；
 * - 空间所有者可以删别人的板（设计稿 §05），删完必须能在回收站里看到并恢复；
 * - `space_id is null` 仅用于兼容未迁移的遗留板，游客板不会出现在登录用户的回收站。
 */
const TRASH_VISIBLE = `(
  (b.space_id is null and b.owner_id = $1)
  or exists (
    select 1 from spaces s
     join space_members m on m.space_id = s.id and m.user_id = $1
    where s.id = b.space_id and s.deleted_at is null
      and (b.owner_id = $1 or m.role = 'owner')
  )
)`;

/** `GET /api/boards/trash` —— 个人回收站，按删除时间倒序，12 行一页。 */
trashRouter.get(
  '/boards/trash',
  handle(async (req, res) => {
    const identity = identityOf(req);
    if (!identity.userId) throw new AppError(401, 'UNAUTHENTICATED', '请先登录');
    const { limit, offset, filter } = trashQuerySchema.parse(req.query);

    const { rows } = await pool.query<TrashRow>(
      `select b.id, b.title, b.space_id, s.name as space_name, b.deleted_at,
              b.deleted_at + make_interval(days => $3::int) as purge_at
         from boards b
         left join spaces s on s.id = b.space_id
        where ${TRASH_VISIBLE} and b.deleted_at is not null
          and ($5 = 'all' or b.deleted_at <= now() - make_interval(days => $3::int - 7))
        order by b.deleted_at desc, b.id desc
        limit $2 offset $4`,
      [identity.userId, limit + 1, TRASH_RETENTION_DAYS, offset, filter],
    );

    const pageRows = rows.slice(0, limit);
    const { rows: countRows } = await pool.query<{ all_total: number; expiring_soon: number; filtered: number }>(
      `select count(*)::int as all_total,
              count(*) filter (where b.deleted_at <= now() - make_interval(days => $2::int - 7))::int as expiring_soon,
              count(*) filter (where $3 = 'all' or b.deleted_at <= now() - make_interval(days => $2::int - 7))::int as filtered
         from boards b
        where ${TRASH_VISIBLE} and b.deleted_at is not null`,
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
      `select count(*)::int as total from boards b where ${TRASH_VISIBLE} and b.deleted_at is not null`,
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
      `delete from boards b where ${TRASH_VISIBLE} and b.deleted_at is not null`,
      [identity.userId],
    );
    res.json({ purged: rowCount ?? 0 });
  }),
);

/**
 * `DELETE /api/boards/:id` —— 删除。
 *
 * - 登录成员：软删除，进回收站，30 天后由每日任务清理；
 *   空间所有者可删任意板，编辑者只能删自己创建的，只读成员 403；
 * - 游客 owner：直接物理删除（临时板没有回收站）。
 */
trashRouter.delete(
  '/boards/:id',
  handle(async (req, res) => {
    const boardId = boardIdSchema.parse(req.params.id);
    const identity = identityOf(req);

    if (identity.userId) {
      const { rows } = await pool.query<{ deleted_at: Date; purge_at: Date }>(
        `update boards b
            set deleted_at = now()
          where b.id = $1 and b.deleted_at is null
            and exists (
              select 1 from space_members m
               where m.space_id = b.space_id and m.user_id = $2
                 and (m.role = 'owner' or (m.role = 'editor' and b.owner_id = $2))
            )
          returning b.deleted_at, b.deleted_at + make_interval(days => $3::int) as purge_at`,
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

type TrashBoardRow = { id: string; title: string; space_id: string | null; owner_id: string | null };
type Queryable = Pick<PoolClient, 'query'>;

/** 回收站里的一块（含空间与创建者），恢复与恢复计划共用。 */
async function loadTrashBoard(
  client: Queryable,
  userId: string,
  boardId: string,
  { forUpdate = false }: { forUpdate?: boolean } = {},
): Promise<TrashBoardRow | null> {
  const { rows } = await client.query<TrashBoardRow>(
    `select b.id, b.title, b.space_id, b.owner_id from boards b
      where b.id = $2 and ${TRASH_VISIBLE} and b.deleted_at is not null
      ${forUpdate ? 'for update of b' : ''}`,
    [userId, boardId],
  );
  return rows[0] ?? null;
}

/**
 * `POST /api/boards/:id/restore` —— 从回收站恢复；同名自动加序号。
 *
 * 登录账号不限量：恢复不做容量判定、不要求先腾位置、不淘汰任何已有板。
 * 事务只用来锁住待恢复的板并统一处理同名追加序号。
 */
trashRouter.post(
  '/boards/:id/restore',
  handle(async (req, res) => {
    const boardId = boardIdSchema.parse(req.params.id);
    const identity = identityOf(req);
    if (!identity.userId) throw new AppError(401, 'UNAUTHENTICATED', '请先登录');

    const client = await pool.connect();
    try {
      await client.query('begin');
      const board = await loadTrashBoard(client, identity.userId, boardId, { forUpdate: true });
      if (!board) throw new AppError(404, 'NOT_FOUND', '回收站里没有这块白板');

      const { rows: takenRows } = await client.query<{ title: string }>(
        'select title from boards where space_id is not distinct from $1 and deleted_at is null and id <> $2',
        [board.space_id, boardId],
      );
      const title = uniqueBoardTitle(
        board.title,
        takenRows.map((row) => row.title),
      );

      await client.query('update boards set deleted_at = null, title = $2 where id = $1', [boardId, title]);
      await client.query('commit');

      res.json({
        id: boardId,
        title,
        renamed: title !== board.title,
        deletedAt: null,
      });
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
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
      `delete from boards b
        where b.id = $2 and ${TRASH_VISIBLE} and b.deleted_at is not null`,
      [identity.userId, boardId],
    );
    if (!rowCount) throw new AppError(404, 'NOT_FOUND', '回收站里没有这块白板');
    res.json({ id: boardId, purged: true });
  }),
);
