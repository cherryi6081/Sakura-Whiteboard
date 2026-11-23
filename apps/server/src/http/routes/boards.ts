import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { can, LIMITS } from '@whiteboard/shared';
import { pool } from '../../infra/db.js';
import { AppError } from '../middlewares/error.js';
import { boardIdSchema, needsResync, opsQuerySchema, paginatePage } from '../../domain/opPage.js';
import { identityOf } from '../../auth/identity.js';
import { issueGuestCookie } from '../../auth/guestCookie.js';
import { resolveBoardAccess } from '../../domain/access.js';
import { TRASH_RETENTION_DAYS } from '../../domain/retention.js';
import { ORDER_STEP, materializeRanks, rankBetween } from '../../domain/boardOrder.js';
import { ensurePersonalSpace, resolveSpaceRole } from '../../domain/spaceAccess.js';
import { ensurePublicBoard } from '../../domain/publicBoard.js';
import { latestSnapshot } from '../../domain/boardSnapshots.js';

/**
 * 白板 REST（M5-1）。
 *
 * - `POST /api/boards`：登录用户 `owner_id = userId`，**不限数量**；无会话时**不再建新板**，
 *   统一返回公共临时板（所有匿名访客共用同一块，见 `domain/publicBoard.ts`）。
 * - `GET /api/boards`：**仅登录用户**，游客 401（游客列表只在本机）。
 * - `GET /api/boards/:id/ops|snapshot`：身份与权限统一由 `resolveBoardAccess` 推导，
 *   不再按"share_mode != private"放行；陌生人访问 private 板一律 404。
 */

export const boardsRouter = Router();

const handle =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

const spaceIdSchema = z.string().regex(/^sp_[A-Za-z0-9_-]{10,32}$/);

const createBoardSchema = z.object({
  title: z.string().trim().min(1).max(LIMITS.boardTitleMax).optional(),
  /** 建到哪个空间；缺省为个人空间（匿名请求忽略此字段） */
  spaceId: spaceIdSchema.optional(),
});

const listQuerySchema = z.object({
  /** 登录账号不限量，前端按页拉全；单页上限 100 防止一次取回过多 */
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** 手动排序与时间解耦后游标不再可靠（会把已排到前面的板重复取回），统一用 offset 分页 */
  offset: z.coerce.number().int().min(0).default(0),
  /** 空间 id；缺省为个人空间 */
  space: spaceIdSchema.optional(),
  /** 板名搜索词；只匹配标题，空串/缺省表示不过滤 */
  q: z.string().trim().max(64).optional(),
  /** 已归档视图：'1' 只列已归档；缺省/'0' 只列未归档（默认列表排除归档） */
  archived: z.enum(['0', '1']).optional(),
});

/** 转义 ILIKE 通配符：用户输入的 `\`、`%`、`_` 按字面匹配，避免 `%` 变成"匹配任意内容" */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

type BoardMetaRow = {
  id: string;
  title: string;
  last_edited_at: Date;
  pinned_at: Date | null;
  archived_at: Date | null;
  thumbnail_url: string | null;
  rank: string | null;
  owner_name: string;
  is_own: boolean;
};

const pinSchema = z.object({ pinned: z.boolean() });

const archiveSchema = z.object({ archived: z.boolean() });

const renameSchema = z.object({
  title: z.string().trim().min(1).max(LIMITS.boardTitleMax),
});

/** `POST /api/boards` —— 登录用户建板；无会话返回公共临时板（不再按游客建新板）。 */
boardsRouter.post(
  '/boards',
  handle(async (req, res) => {
    const { title, spaceId } = createBoardSchema.parse(req.body ?? {});
    const identity = identityOf(req);
    const boardTitle = title ?? '未命名白板';

    let ownerId: string | null = null;
    let targetSpaceId: string | null = null;

    if (identity.userId) {
      ownerId = identity.userId;
      // 团队空间建板：editor/owner 可建，viewer 403，非成员 404
      if (spaceId) {
        const role = await resolveSpaceRole(spaceId, identity.userId);
        if (!role) throw new AppError(404, 'NOT_FOUND', 'space not found');
        if (!can(role, 'createBoard')) throw new AppError(403, 'FORBIDDEN', '只读成员不能新建白板');
        targetSpaceId = spaceId;
      } else {
        targetSpaceId = (await ensurePersonalSpace(identity.userId)).id;
      }
    } else {
      // 匿名建板统一落到公共临时板：同一个 id、同一个协作房间，不新建行。
      // 仍签发/刷新签名 guest cookie，历史游客板的认领与匿名身份展示继续可用。
      if (!identity.guestId) issueGuestCookie(res);
      const publicBoard = await ensurePublicBoard();
      res.status(201).json({
        id: publicBoard.id,
        title: publicBoard.title,
        ownerType: 'guest',
        quota: null,
        public: true,
        createdAt: new Date().toISOString(),
      });
      return;
    }

    const boardId = nanoid(12);
    const client = await pool.connect();
    try {
      await client.query('begin');
      // 同一 owner 的创建串行：避免并发请求基于同一份旧计数各自淘汰一块
      const lockKey = `board-create:user:${ownerId}:${targetSpaceId}`;
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [lockKey]);

      // 与空间退出/解散串行：锁住空间与成员行，避免在空间刚被解散后又插进一块
      // 无归属空间的板（解散事务会等待这里提交，然后把这块新板一起迁走）。
      if (spaceId) {
        const { rows: liveRows } = await client.query(
          `select 1 from spaces s
             join space_members m on m.space_id = s.id and m.user_id = $2
            where s.id = $1 and s.deleted_at is null
            for share of s, m`,
          [spaceId, identity.userId],
        );
        if (!liveRows[0]) throw new AppError(404, 'NOT_FOUND', 'space not found');
      }

      const { rows } = await client.query<{ id: string; title: string; created_at: Date }>(
        `insert into boards (id, title, owner_id, owner_guest_id, share_mode, space_id)
         values ($1, $2, $3, null, 'private', $4)
         returning id, title, created_at`,
        [boardId, boardTitle, ownerId, targetSpaceId],
      );
      const row = rows[0];
      if (!row) throw new AppError(500, 'INTERNAL', 'board insert returned no row');
      await client.query('commit');

      res.status(201).json({
        id: row.id,
        title: row.title,
        ownerType: 'user',
        quota: null,
        createdAt: row.created_at.toISOString(),
      });
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }),
);

/**
 * `POST /api/boards/:id/opened` —— 进入白板时累加打开次数（列表淘汰的排序依据）。
 *
 * 单行主键 UPDATE：不做读改写、不写 ops、不碰 `last_edited_at`，因此不会触发
 * 列表重新排序，也不会进入编辑回写的热点路径。前端每次进板 fire-and-forget 调一次。
 */
boardsRouter.post(
  '/boards/:id/opened',
  handle(async (req, res) => {
    const boardId = boardIdSchema.parse(req.params.id);
    const access = await resolveBoardAccess(boardId, identityOf(req), shareTokenOf(req));
    if (!access.ok) throw new AppError(404, 'NOT_FOUND', 'board not found');

    await pool.query(
      `update boards
          set opened_count = opened_count + 1, last_opened_at = now()
        where id = $1 and deleted_at is null`,
      [boardId],
    );
    res.status(204).end();
  }),
);

/**
 * `GET /api/boards` —— 登录用户的"最近编辑"；游客 401（列表只在本机）。
 *
 * 排序契约（设计稿 boards-drag-sort §3.3）：
 * 置顶组恒在上 → 手动模式下组内按 `rank` → 其余按最近编辑 → id 兜底。
 * `sort_mode` 为 auto（默认，等同于没有记录）时完全忽略 rank，与旧行为逐字节一致。
 */
boardsRouter.get(
  '/boards',
  handle(async (req, res) => {
    const identity = identityOf(req);
    if (!identity.userId) throw new AppError(401, 'UNAUTHENTICATED', '游客没有服务端白板列表，请使用本机列表');

    const { limit, offset, space, q, archived } = listQuerySchema.parse(req.query);
    // 空串表示不搜索；转义后交给 ILIKE，大小写不敏感的子串匹配
    const keyword = q ? escapeLike(q) : '';
    // 已归档视图只列归档板；默认列表继续排除归档
    const archivedOnly = archived === '1';
    // 空间是列表的一级上下文：不传 = 个人空间；非成员统一 404，不泄露空间是否存在
    const spaceId = space ?? (await ensurePersonalSpace(identity.userId)).id;
    const role = await resolveSpaceRole(spaceId, identity.userId);
    if (!role) throw new AppError(404, 'NOT_FOUND', 'space not found');

    const { rows: settingRows } = await pool.query<{ sort_mode: string }>(
      'select sort_mode from board_user_settings where user_id = $1',
      [identity.userId],
    );
    const sortMode = settingRows[0]?.sort_mode === 'manual' ? 'manual' : 'auto';

    const { rows } = await pool.query<BoardMetaRow>(
      `select b.id, b.title, b.last_edited_at, b.pinned_at, b.archived_at, b.thumbnail_url, o.rank,
              u.display_name as owner_name,
              (b.owner_id = $1) as is_own
         from boards b
         left join board_user_order o on o.board_id = b.id and o.user_id = $1
         left join users u on u.id = b.owner_id
        where b.space_id = $5 and b.deleted_at is null
          and ((b.archived_at is not null) = $7::boolean)
          and ($6 = '' or b.title ilike '%' || $6 || '%')
        order by (b.pinned_at is not null) desc,
                 case when $4 = 'manual' then o.rank end asc nulls last,
                 b.last_edited_at desc, b.id desc
        limit $2 offset $3`,
      [identity.userId, limit, offset, sortMode, spaceId, keyword, archivedOnly],
    );

    res.json({
      spaceId,
      spaceRole: role,
      boards: rows.map((row) => ({
        id: row.id,
        title: row.title,
        // 空间是唯一权限来源：同一空间内所有人看到同一个角色
        role,
        lastEditedAt: row.last_edited_at.toISOString(),
        pinnedAt: row.pinned_at ? row.pinned_at.toISOString() : null,
        archivedAt: row.archived_at ? row.archived_at.toISOString() : null,
        thumbnailUrl: row.thumbnail_url,
        rank: row.rank === null ? null : Number(row.rank),
        ownerName: row.owner_name,
        isOwn: row.is_own,
      })),
      sortMode,
      nextOffset: rows.length === limit ? offset + limit : null,
    });
  }),
);

/**
 * `PATCH /api/boards/:id` —— 重命名。
 *
 * owner / editor 可改，viewer 只读不能改。**不动 `last_edited_at`**：
 * 改名是列表层的整理动作，不应把白板顶到「最近编辑」的第一位。
 */
boardsRouter.patch(
  '/boards/:id',
  handle(async (req, res) => {
    const boardId = boardIdSchema.parse(req.params.id);
    const { title } = renameSchema.parse(req.body ?? {});
    const access = await resolveBoardAccess(boardId, identityOf(req));
    if (!access.ok) throw new AppError(404, 'NOT_FOUND', 'board not found');
    if (access.role === 'viewer') throw new AppError(403, 'FORBIDDEN', '只读成员不能重命名');

    const { rows } = await pool.query<{ id: string; title: string }>(
      `update boards set title = $2 where id = $1 returning id, title`,
      [boardId, title],
    );
    const row = rows[0];
    if (!row) throw new AppError(404, 'NOT_FOUND', 'board not found');
    res.json({ id: row.id, title: row.title });
  }),
);

/**
 * `PATCH /api/boards/:id/pin` —— 置顶 / 取消置顶。
 *
 * 置顶是**空间共享**的列表偏好（复用 `pinned_at`），owner/editor 都能改；viewer 只读不可改。
 * 只写 `pinned_at`，不改 `last_edited_at`，避免改变「最近打开」的语义。
 */
boardsRouter.patch(
  '/boards/:id/pin',
  handle(async (req, res) => {
    const boardId = boardIdSchema.parse(req.params.id);
    const { pinned } = pinSchema.parse(req.body ?? {});
    const access = await resolveBoardAccess(boardId, identityOf(req));
    if (!access.ok) throw new AppError(404, 'NOT_FOUND', 'board not found');
    if (access.role === 'viewer') throw new AppError(403, 'FORBIDDEN', '只读成员不能置顶');

    const { rows } = await pool.query<{ pinned_at: Date | null }>(
      `update boards
          set pinned_at = case when $2 then now() else null end
        where id = $1
        returning pinned_at`,
      [boardId, pinned],
    );

    res.json({ id: boardId, pinnedAt: rows[0]?.pinned_at?.toISOString() ?? null });
  }),
);

/**
 * `PATCH /api/boards/:id/archive` —— 归档 / 取消归档。
 *
 * 归档只是把板从默认列表挪到「已归档」，不改变访问与分享权限，也不加锁；
 * 权限与置顶一致：owner/editor 可改，viewer 只读不可改。
 * 只写 `archived_at`，**不动 `last_edited_at`**，避免归档动作把板顶到最近编辑的第一位。
 */
boardsRouter.patch(
  '/boards/:id/archive',
  handle(async (req, res) => {
    const boardId = boardIdSchema.parse(req.params.id);
    const { archived } = archiveSchema.parse(req.body ?? {});
    const access = await resolveBoardAccess(boardId, identityOf(req));
    if (!access.ok) throw new AppError(404, 'NOT_FOUND', 'board not found');
    if (access.role === 'viewer') throw new AppError(403, 'FORBIDDEN', '只读成员不能归档');

    const { rows } = await pool.query<{ archived_at: Date | null }>(
      `update boards
          set archived_at = case when $2 then now() else null end
        where id = $1
        returning archived_at`,
      [boardId, archived],
    );

    res.json({ id: boardId, archivedAt: rows[0]?.archived_at?.toISOString() ?? null });
  }),
);

/**
 * 批量操作（设计稿 boards-bulk-select §08.4）：
 * - 一次查出角色，避免 30 张卡发 30 次 resolveBoardAccess；
 * - 返回逐项结果，前端据此保留成功项、只对失败项提示；
 * - 置顶按传入顺序写入递减 1ms 的 pinned_at，保证列表顺序与视觉顺序一致。
 */
const batchIdsSchema = z.object({
  ids: z.array(boardIdSchema).min(1).max(50),
});

const batchPinSchema = batchIdsSchema.extend({ pinned: z.boolean() });

async function batchRoles(ids: string[], userId: string): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const { rows } = await pool.query<{ id: string; role: string | null }>(
    `select b.id,
            (select m.role from space_members m
              where m.space_id = b.space_id and m.user_id = $2) as role
       from boards b
      where b.id = any($1::text[]) and b.deleted_at is null and b.archived_at is null`,
    [ids, userId],
  );
  const map = new Map<string, string>();
  for (const row of rows) if (row.role) map.set(row.id, row.role);
  return map;
}

/** `POST /api/boards/batch/pin` —— 批量置顶 / 取消置顶（owner/editor）。 */
boardsRouter.post(
  '/boards/batch/pin',
  handle(async (req, res) => {
    const identity = identityOf(req);
    if (!identity.userId) throw new AppError(401, 'UNAUTHORIZED', 'login required');
    const { ids: rawIds, pinned } = batchPinSchema.parse(req.body ?? {});
    const ids = [...new Set(rawIds)];
    const roles = await batchRoles(ids, identity.userId);
    const allowed = ids.filter((id) => {
      const role = roles.get(id);
      return role === 'owner' || role === 'editor';
    });

    const pinnedAt = new Map<string, string | null>();
    if (allowed.length > 0) {
      const { rows } = await pool.query<{ id: string; pinned_at: Date | null }>(
        `update boards b
            set pinned_at = case
                  when $2 then now() - ((u.ord - 1)::int * interval '1 millisecond')
                  else null
                end
           from unnest($1::text[]) with ordinality as u(id, ord)
          where b.id = u.id
          returning b.id, b.pinned_at`,
        [allowed, pinned],
      );
      for (const row of rows) pinnedAt.set(row.id, row.pinned_at?.toISOString() ?? null);
    }

    const items = ids.map((id) => {
      const role = roles.get(id);
      if (!role) return { id, ok: false, reason: 'not_found' as const };
      if (!allowed.includes(id)) return { id, ok: false, reason: 'forbidden' as const, role };
      return { id, ok: true, role, pinnedAt: pinnedAt.get(id) ?? null };
    });

    res.json({ pinned, items, okCount: allowed.length, skippedCount: ids.length - allowed.length });
  }),
);

/** `POST /api/boards/batch/trash` —— 批量删除。
 *  登录成员移入回收站（所有者任意；编辑者仅自己创建的）；
 *  游客的临时板没有回收站，按 cookie 归属物理删除。 */
boardsRouter.post(
  '/boards/batch/trash',
  handle(async (req, res) => {
    const identity = identityOf(req);
    const { ids: rawIds } = batchIdsSchema.parse(req.body ?? {});
    const ids = [...new Set(rawIds)];

    // 游客分支：与单条 DELETE /boards/:id 同一条物理删除路径，只认 owner_guest_id
    if (!identity.userId) {
      if (!identity.guestId) throw new AppError(401, 'UNAUTHORIZED', 'login required');
      const { rows } = await pool.query<{ id: string }>(
        `delete from boards
          where id = any($1::text[]) and owner_guest_id = $2 and deleted_at is null
          returning id`,
        [ids, identity.guestId],
      );
      const purged = new Set(rows.map((row) => row.id));
      const items = ids.map((id) =>
        purged.has(id)
          ? { id, ok: true as const, purged: true as const }
          : { id, ok: false as const, reason: 'not_found' as const },
      );
      res.json({ mode: 'purged', items, okCount: rows.length, skippedCount: ids.length - rows.length });
      return;
    }

    const { rows } = await pool.query<{ id: string; deleted_at: Date; purge_at: Date }>(
      `update boards b
          set deleted_at = now()
        where b.id = any($1::text[])
          and b.deleted_at is null and b.archived_at is null
          and exists (
            select 1 from space_members m
             where m.space_id = b.space_id and m.user_id = $2
               and (m.role = 'owner' or (m.role = 'editor' and b.owner_id = $2))
          )
        returning b.id, b.deleted_at,
                  b.deleted_at + make_interval(days => $3::int) as purge_at`,
      [ids, identity.userId, TRASH_RETENTION_DAYS],
    );
    const moved = new Map(rows.map((row) => [row.id, row]));
    const items = ids.map((id) => {
      const row = moved.get(id);
      if (!row) return { id, ok: false, reason: 'forbidden' as const };
      return {
        id,
        ok: true,
        deletedAt: row.deleted_at.toISOString(),
        purgeAt: row.purge_at.toISOString(),
      };
    });

    res.json({ mode: 'trash', items, okCount: rows.length, skippedCount: ids.length - rows.length });
  }),
);

/**
 * 手动排序（设计稿 boards-drag-sort §3.2）。
 *
 * 语义是「放到两个邻居之间」而不是「放到第 N 位」：客户端只加载 6/30 条，
 * 邻居是它唯一确定的信息。rank 存在 `board_user_order`，作用域是「该用户 + 该组」，
 * 不校验角色——能看见这块板的人都能排自己的列表；置顶仍走 owner/editor 的 /pin。
 */

const orderSchema = z.object({
  /** 落点左侧的邻居；null = 组首 */
  beforeId: boardIdSchema.nullish(),
  /** 落点右侧的邻居；null = 组尾 */
  afterId: boardIdSchema.nullish(),
});

const sortModeSchema = z.object({ mode: z.enum(['auto', 'manual']) });

/**
 * 同一空间内、与目标同组的白板 id，按视觉顺序。
 *
 * 可见性由空间决定（空间是唯一权限来源），所以这里不需要 userId；
 * 早先版本按成员表过滤时留下的 `$1` 已移除——保留它会让 pg 报
 * `42P18 could not determine data type of parameter $1`，导致排序接口 500。
 */
async function groupBoardIds(pinned: boolean, spaceId: string): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `select b.id
       from boards b
      where b.space_id = $2 and b.archived_at is null and b.deleted_at is null
        and (($1::boolean and b.pinned_at is not null) or (not $1::boolean and b.pinned_at is null))
      order by case when $1::boolean then b.pinned_at end desc nulls last,
               b.last_edited_at desc, b.id desc`,
    [pinned, spaceId],
  );
  return rows.map((row) => row.id);
}

/** 把某一组的当前顺序整体落成 rank = 1024, 2048…（首次拖动 / 间隙不足时调用）。 */
async function materializeGroup(userId: string, pinned: boolean, spaceId: string): Promise<void> {
  const ranks = materializeRanks(await groupBoardIds(pinned, spaceId));
  if (ranks.size === 0) return;
  const ids = [...ranks.keys()];
  await pool.query(
    `insert into board_user_order (user_id, board_id, rank)
     select $1, u.id, u.ord * $3::numeric
       from unnest($2::text[]) with ordinality as u(id, ord)
     on conflict (user_id, board_id) do update set rank = excluded.rank, updated_at = now()`,
    [userId, ids, ORDER_STEP],
  );
}

async function ranksOf(userId: string, ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const { rows } = await pool.query<{ board_id: string; rank: string }>(
    'select board_id, rank from board_user_order where user_id = $1 and board_id = any($2::text[])',
    [userId, ids],
  );
  return new Map(rows.map((row) => [row.board_id, Number(row.rank)]));
}

/** `PATCH /api/boards/:id/order` —— 把白板放到两个邻居之间；首次写入顺带切到手动模式。 */
boardsRouter.patch(
  '/boards/:id/order',
  handle(async (req, res) => {
    const identity = identityOf(req);
    if (!identity.userId) throw new AppError(401, 'UNAUTHENTICATED', '登录后才能调整顺序');
    const boardId = boardIdSchema.parse(req.params.id);
    const { beforeId, afterId } = orderSchema.parse(req.body ?? {});
    if (beforeId === boardId || afterId === boardId) {
      throw new AppError(400, 'INVALID_NEIGHBOR', '落点邻居不能是白板自己');
    }

    const access = await resolveBoardAccess(boardId, identity);
    if (!access.ok) throw new AppError(404, 'NOT_FOUND', 'board not found');
    // 只读成员不渲染把手，这里是服务端的第二道门
    if (!can(access.role, 'reorderBoard')) throw new AppError(403, 'FORBIDDEN', '只读成员不能调整顺序');

    const { rows: boardRows } = await pool.query<{ pinned_at: Date | null; space_id: string | null }>(
      'select pinned_at, space_id from boards where id = $1',
      [boardId],
    );
    const pinned = Boolean(boardRows[0]?.pinned_at);
    // 排序作用域是「本空间 + 本用户」，不能用跨空间的可见集合算邻居
    const spaceId = boardRows[0]?.space_id ?? '';
    if (!spaceId) throw new AppError(404, 'NOT_FOUND', 'board not found');

    // 邻居失效（被删 / 被置顶换了组）时返回 409：客户端重拉一次再算落点
    const neighbors = [beforeId, afterId].filter((id): id is string => Boolean(id));
    const visibleIds = new Set(await groupBoardIds(pinned, spaceId));
    if (neighbors.some((id) => !visibleIds.has(id))) {
      throw new AppError(409, 'STALE_NEIGHBOR', '落点附近的顺序已变化，请刷新后重试');
    }

    const { rows: settingRows } = await pool.query<{ sort_mode: string }>(
      'select sort_mode from board_user_settings where user_id = $1',
      [identity.userId],
    );
    if (settingRows[0]?.sort_mode !== 'manual') {
      // 首次拖动：整组当前顺序先落成 rank，再算落点，避免只有被拖的那块有 rank
      await materializeGroup(identity.userId, pinned, spaceId);
      await pool.query(
        `insert into board_user_settings (user_id, sort_mode) values ($1, 'manual')
         on conflict (user_id) do update set sort_mode = 'manual', updated_at = now()`,
        [identity.userId],
      );
    }

    let ranks = await ranksOf(identity.userId, neighbors);
    // 手动模式是账号级设置，但 rank 是「用户 + 分组」级别的：
    // 换到还没排过序的空间/分组时邻居没有 rank，不能把 undefined 当 null
    // 走「组首/组尾」公式（beforeId 有值却按 null 算会得到 1024，直接排到最前）。
    if (neighbors.some((id) => !ranks.has(id))) {
      await materializeGroup(identity.userId, pinned, spaceId);
      ranks = await ranksOf(identity.userId, neighbors);
    }
    let rank = rankBetween(beforeId ? ranks.get(beforeId) ?? null : null, afterId ? ranks.get(afterId) ?? null : null);
    if (rank === null) {
      // 间隙不足或邻居没有 rank：整组重排后用新的 rank 再算一次
      await materializeGroup(identity.userId, pinned, spaceId);
      ranks = await ranksOf(identity.userId, neighbors);
      rank = rankBetween(beforeId ? ranks.get(beforeId) ?? null : null, afterId ? ranks.get(afterId) ?? null : null);
    }
    if (rank === null) throw new AppError(409, 'STALE_NEIGHBOR', '落点附近的顺序已变化，请刷新后重试');

    await pool.query(
      `insert into board_user_order (user_id, board_id, rank) values ($1, $2, $3)
       on conflict (user_id, board_id) do update set rank = excluded.rank, updated_at = now()`,
      [identity.userId, boardId, rank],
    );
    res.json({ id: boardId, rank, sortMode: 'manual' });
  }),
);

/** `PUT /api/boards/sort-mode` —— 恢复自动会清空该用户的全部 rank，不动别人的列表。 */
boardsRouter.put(
  '/boards/sort-mode',
  handle(async (req, res) => {
    const identity = identityOf(req);
    if (!identity.userId) throw new AppError(401, 'UNAUTHENTICATED', '登录后才能切换排序模式');
    const { mode } = sortModeSchema.parse(req.body ?? {});

    if (mode === 'auto') {
      await pool.query('delete from board_user_order where user_id = $1', [identity.userId]);
    }
    await pool.query(
      `insert into board_user_settings (user_id, sort_mode) values ($1, $2)
       on conflict (user_id) do update set sort_mode = excluded.sort_mode, updated_at = now()`,
      [identity.userId, mode],
    );
    res.json({ mode });
  }),
);

type OpRow = {
  seq: string;
  op_id: string;
  client_id: string;
  kind: string;
  element_id: string;
  payload: Record<string, unknown>;
};

/**
 * 分享 token 的来源（M5-2）：`x-share-token` 头（正式），`?share=` 仅为老客户端兼容保留。
 * 分享**链接**已改为 fragment（`/board/:id#share=`），不会进服务端日志；
 * 这里的 query 读取会在下个版本移除，新客户端一律走头。
 * 它不是身份，只用于"匿名凭链接进入"；权限仍由 `resolveBoardAccess` 统一判定。
 */
function shareTokenOf(req: Request): string | null {
  const fromQuery = typeof req.query.share === 'string' ? req.query.share : null;
  const fromHeader = typeof req.headers['x-share-token'] === 'string' ? req.headers['x-share-token'] : null;
  return fromQuery ?? fromHeader;
}

/** `GET /api/boards/:id/ops?since=<seq>&limit=` —— 按 seq 升序补拉。 */
boardsRouter.get(
  '/boards/:id/ops',
  handle(async (req, res) => {
    const boardId = boardIdSchema.parse(req.params.id);
    const { since, limit } = opsQuerySchema.parse(req.query);
    const access = await resolveBoardAccess(boardId, identityOf(req), shareTokenOf(req));
    if (!access.ok) throw new AppError(404, 'NOT_FOUND', 'board not found');
    const board = access.board;

    if (needsResync(since, board.last_seq)) {
      res.json({
        boardId,
        since,
        lastSeq: board.last_seq,
        resync: true,
        hasMore: false,
        nextSince: board.last_seq,
        ops: [],
      });
      return;
    }

    const { rows } = await pool.query<OpRow>(
      `select seq, op_id, client_id, kind, element_id, payload
         from board_ops
        where board_id = $1 and seq > $2
        order by seq asc
        limit $3`,
      [boardId, since, limit + 1],
    );

    const pageRows = rows.slice(0, limit);
    const lastPageRow = pageRows[pageRows.length - 1];
    const lastRowSeq = lastPageRow ? Number(lastPageRow.seq) : null;
    const page = paginatePage({ since, limit, rowCount: rows.length, lastRowSeq });

    res.json({
      boardId,
      since,
      lastSeq: board.last_seq,
      resync: false,
      hasMore: page.hasMore,
      nextSince: page.nextSince,
      ops: pageRows.map((row) => ({
        seq: Number(row.seq),
        opId: row.op_id,
        clientId: row.client_id,
        kind: row.kind,
        elementId: row.element_id,
        op: row.payload,
      })),
    });
  }),
);

type ElementRow = {
  element_id: string;
  version: string;
  version_nonce: string;
  data: Record<string, unknown>;
};

/**
 * `GET /api/boards/:id/watermark` —— 开板前的轻量水位校验。
 *
 * 只读 `boards.last_seq` 与最新快照 seq 两列（不读元素表、不解析快照 state），
 * 让客户端在画首帧之前就能判断本地缓存是否已经落后。
 */
boardsRouter.get(
  '/boards/:id/watermark',
  handle(async (req, res) => {
    const boardId = boardIdSchema.parse(req.params.id);
    const access = await resolveBoardAccess(boardId, identityOf(req), shareTokenOf(req));
    if (!access.ok) throw new AppError(404, 'NOT_FOUND', 'board not found');
    const { rows } = await pool.query<{ seq: string }>(
      'select coalesce(max(seq), 0) as seq from board_snapshots where board_id = $1',
      [boardId],
    );
    res.json({
      boardId,
      lastSeq: access.board.last_seq,
      snapshotSeq: Number(rows[0]?.seq ?? 0),
    });
  }),
);

/** `GET /api/boards/:id/snapshot` —— 整板重载（gap 过大或补拉失败时回退）。 */
boardsRouter.get(
  '/boards/:id/snapshot',
  handle(async (req, res) => {
    const boardId = boardIdSchema.parse(req.params.id);
    const access = await resolveBoardAccess(boardId, identityOf(req), shareTokenOf(req));
    if (!access.ok) throw new AppError(404, 'NOT_FOUND', 'board not found');
    const board = access.board;

    // 只返回“与 last_seq 同步”的快照：快照按每 100 条 op 落一次，清空这类批量 delete
    // 会让快照停在清空前（seq 落后、state 仍是旧元素）。若把旧快照当首帧发出去，
    // 客户端会先画出已被删除的内容、再补拉 delete op 抹掉，表现为“闪一下”。
    // 因此快照落后时直接按元素表现算（与无快照时的回退路径同源，返回 seq = last_seq）。
    const snapshot = await latestSnapshot(boardId);
    if (snapshot && snapshot.seq >= board.last_seq) {
      res.json({ boardId, seq: snapshot.seq, elements: snapshot.elements });
      return;
    }

    const { rows } = await pool.query<ElementRow>(
      `select element_id, version, version_nonce, data
         from elements
        where board_id = $1 and is_deleted = false
        order by zindex_key asc, element_id asc`,
      [boardId],
    );

    res.json({
      boardId,
      seq: board.last_seq,
      elements: rows.map((row) => ({
        ...row.data,
        id: row.element_id,
        version: Number(row.version),
        versionNonce: Number(row.version_nonce),
        isDeleted: false,
      })),
    });
  }),
);
