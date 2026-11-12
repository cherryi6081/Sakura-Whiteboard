import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { pool } from '../../infra/db.js';
import { ensureRedisConnected, redis } from '../../infra/redis.js';
import { AppError } from '../middlewares/error.js';
import { boardIdSchema, needsResync, opsQuerySchema, paginatePage } from '../../domain/opPage.js';
import { identityOf } from '../../auth/identity.js';
import { issueGuestCookie } from '../../auth/guestCookie.js';
import { resolveBoardAccess } from '../../domain/access.js';
import { TRASH_RETENTION_DAYS } from '../../domain/retention.js';

/**
 * 白板 REST（M5-1）。
 *
 * - `POST /api/boards`：登录用户 `owner_id = userId`；无会话时按游客建板（`owner_guest_id`
 *   取签名 cookie），满足 §4.5.3 配额（24h 3 块 / 未归档 ≤6）。
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

const GUEST_BOARDS_PER_24H = 3;
const GUEST_UNARCHIVED_MAX = 6;

const createBoardSchema = z.object({
  title: z.string().trim().min(1).max(80).optional(),
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(30).default(20),
  cursor: z.string().datetime().optional(),
});

type BoardMetaRow = {
  id: string;
  title: string;
  role: string;
  last_edited_at: Date;
  pinned_at: Date | null;
};

const pinSchema = z.object({ pinned: z.boolean() });

const renameSchema = z.object({
  title: z.string().trim().min(1).max(80),
});

async function enforceGuestQuota(guestId: string): Promise<void> {
  const { rows } = await pool.query<{ unarchived: number }>(
    `select count(*)::int as unarchived from boards
      where owner_guest_id = $1 and archived_at is null and deleted_at is null`,
    [guestId],
  );
  if ((rows[0]?.unarchived ?? 0) >= GUEST_UNARCHIVED_MAX) {
    throw new AppError(429, 'QUOTA_EXCEEDED', `游客最多保留 ${GUEST_UNARCHIVED_MAX} 块未归档白板，请归档或注册后继续`);
  }

  let created: number;
  try {
    await ensureRedisConnected();
    const key = `rl:board:create:${guestId}`;
    created = await redis.incr(key);
    if (created === 1) await redis.expire(key, 24 * 60 * 60);
  } catch {
    // Redis 不可用时退回 PG 计数（降级路径必须打日志，不能静默）
    const { rows: fallback } = await pool.query<{ created: number }>(
      `select count(*)::int as created from boards
        where owner_guest_id = $1 and created_at > now() - interval '24 hours' and deleted_at is null`,
      [guestId],
    );
    created = fallback[0]?.created ?? 0;
    console.warn('[boards] redis 配额计数不可用，已退回 PG 计数', { guestId });
  }

  if (created > GUEST_BOARDS_PER_24H) {
    // 超限时把多计的一次退回，避免持续请求把窗口越撑越紧
    try {
      await ensureRedisConnected();
      await redis.decr(`rl:board:create:${guestId}`);
    } catch {
      /* ignore */
    }
    throw new AppError(429, 'QUOTA_EXCEEDED', `游客每 24 小时最多新建 ${GUEST_BOARDS_PER_24H} 块白板，请稍后再试或注册`);
  }
}

/** `POST /api/boards` —— 无会话按游客建板（必要时签发 `wb_gid`）。 */
boardsRouter.post(
  '/boards',
  handle(async (req, res) => {
    const { title } = createBoardSchema.parse(req.body ?? {});
    const identity = identityOf(req);
    const boardTitle = title ?? '未命名白板';

    let ownerId: string | null = null;
    let ownerGuestId: string | null = null;

    if (identity.userId) {
      ownerId = identity.userId;
    } else {
      let guestId = identity.guestId;
      if (!guestId) guestId = issueGuestCookie(res);
      await enforceGuestQuota(guestId);
      ownerGuestId = guestId;
    }

    const boardId = nanoid(12);
    const { rows } = await pool.query<{ id: string; title: string; created_at: Date }>(
      `insert into boards (id, title, owner_id, owner_guest_id, share_mode)
       values ($1, $2, $3, $4, 'private')
       returning id, title, created_at`,
      [boardId, boardTitle, ownerId, ownerGuestId],
    );
    const row = rows[0];
    if (!row) throw new AppError(500, 'INTERNAL', 'board insert returned no row');

    res.status(201).json({
      id: row.id,
      title: row.title,
      ownerType: ownerId ? 'user' : 'guest',
      quota: ownerGuestId
        ? { per24h: GUEST_BOARDS_PER_24H, unarchivedMax: GUEST_UNARCHIVED_MAX }
        : null,
      createdAt: row.created_at.toISOString(),
    });
  }),
);

/** `GET /api/boards` —— 登录用户的"最近编辑"；游客 401（列表只在本机）。 */
boardsRouter.get(
  '/boards',
  handle(async (req, res) => {
    const identity = identityOf(req);
    if (!identity.userId) throw new AppError(401, 'UNAUTHENTICATED', '游客没有服务端白板列表，请使用本机列表');

    const { limit, cursor } = listQuerySchema.parse(req.query);
    const { rows } = await pool.query<BoardMetaRow>(
      `select b.id, b.title, 'owner' as role, b.last_edited_at, b.pinned_at
         from boards b
        where b.owner_id = $1 and b.archived_at is null and b.deleted_at is null
          and ($2::timestamptz is null or b.last_edited_at < $2::timestamptz)
        union all
       select b.id, b.title, m.role, b.last_edited_at, b.pinned_at
         from boards b
         join board_members m on m.board_id = b.id
        where m.user_id = $1 and b.archived_at is null and b.deleted_at is null
          and ($2::timestamptz is null or b.last_edited_at < $2::timestamptz)
        order by pinned_at desc nulls last, last_edited_at desc, id desc
        limit $3`,
      [identity.userId, cursor ?? null, limit],
    );

    const last = rows[rows.length - 1];
    res.json({
      boards: rows.map((row) => ({
        id: row.id,
        title: row.title,
        role: row.role,
        lastEditedAt: row.last_edited_at.toISOString(),
        pinnedAt: row.pinned_at ? row.pinned_at.toISOString() : null,
      })),
      nextCursor: last ? last.last_edited_at.toISOString() : null,
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
            case when b.owner_id = $2 then 'owner' else m.role end as role
       from boards b
       left join board_members m on m.board_id = b.id and m.user_id = $2
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

/** `POST /api/boards/batch/trash` —— 批量移入回收站（仅 owner）。 */
boardsRouter.post(
  '/boards/batch/trash',
  handle(async (req, res) => {
    const identity = identityOf(req);
    if (!identity.userId) throw new AppError(401, 'UNAUTHORIZED', 'login required');
    const { ids: rawIds } = batchIdsSchema.parse(req.body ?? {});
    const ids = [...new Set(rawIds)];

    const { rows } = await pool.query<{ id: string; deleted_at: Date; purge_at: Date }>(
      `update boards
          set deleted_at = now()
        where id = any($1::text[]) and owner_id = $2
          and deleted_at is null and archived_at is null
        returning id, deleted_at,
                  deleted_at + make_interval(days => $3::int) as purge_at`,
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

    res.json({ items, okCount: rows.length, skippedCount: ids.length - rows.length });
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
 * 分享 token 的来源（M5-2）：`?share=` 或 `x-share-token` 头。
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

/** `GET /api/boards/:id/snapshot` —— 整板重载（gap 过大或补拉失败时回退）。 */
boardsRouter.get(
  '/boards/:id/snapshot',
  handle(async (req, res) => {
    const boardId = boardIdSchema.parse(req.params.id);
    const access = await resolveBoardAccess(boardId, identityOf(req), shareTokenOf(req));
    if (!access.ok) throw new AppError(404, 'NOT_FOUND', 'board not found');
    const board = access.board;

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
