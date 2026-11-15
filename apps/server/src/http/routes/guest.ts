import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { pool } from '../../infra/db.js';
import { AppError } from '../middlewares/error.js';
import { identityOf } from '../../auth/identity.js';
import { issueGuestCookie } from '../../auth/guestCookie.js';
import { ensurePersonalSpace } from '../../domain/spaceAccess.js';
import { BOARD_CAPACITY } from '../../domain/boardCapacity.js';

/**
 * 游客接口（开发文档 §7.1.7）。
 *
 * - `GET /api/guest/me`：前端启动时调用一次，确保签名 `wb_gid` 已下发（HttpOnly，JS 读不到），
 *   并返回游客徽标与配额进度。已登录时仍返回 guestId —— 它是"待认领临时板"的凭据。
 * - `GET /api/guest/claim-preview` / `POST /api/guest/claim`：需会话；认领的凭据是
 *   **会话里的 userId + 当前请求 cookie 里的 guestId**，不接受任何跨用户传递。
 * - 转入口径（v1.8）：**全转或整体拒绝**，不接收前端 id 列表、不做部分转入、不淘汰已有板；
 *   转入目标固定为当前账号的个人空间，容量按「个人空间里我创建的未删除未归档板」计。
 */

export const guestRouter = Router();

const handle =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

guestRouter.get(
  '/guest/me',
  handle(async (req, res) => {
    const identity = identityOf(req);
    const guestId = identity.guestId ?? issueGuestCookie(res);

    let user: { id: string; email: string | null; displayName: string; color: string } | null = null;
    if (identity.userId) {
      const { rows } = await pool.query<{ id: string; email: string | null; display_name: string; color: string }>(
        'select id, email, display_name, color from users where id = $1',
        [identity.userId],
      );
      const row = rows[0];
      if (row) user = { id: row.id, email: row.email, displayName: row.display_name, color: row.color };
    }

    const { rows: counts } = await pool.query<{ unarchived: number; created_24h: number }>(
      `select count(*) filter (where archived_at is null and deleted_at is null)::int as unarchived,
              count(*) filter (where created_at > now() - interval '24 hours' and deleted_at is null)::int as created_24h
         from boards
        where owner_guest_id = $1`,
      [guestId],
    );

    res.json({
      guestId,
      displayName: '游客',
      color: '#A85C7C',
      isGuest: !identity.userId,
      authenticated: Boolean(identity.userId),
      user,
      quota: {
        unarchivedMax: 6,
        unarchivedUsed: counts[0]?.unarchived ?? 0,
        per24h: 3,
        created24h: counts[0]?.created_24h ?? 0,
      },
    });
  }),
);

type GuestBoardRow = { id: string; title: string; last_edited_at: Date };

/** 容量口径与建板/恢复完全一致：目标空间里「我创建的、未删除未归档」的板 */
async function countUsedBoards(client: Pick<PoolClient, 'query'>, userId: string, spaceId: string): Promise<number> {
  const { rows } = await client.query<{ used: number }>(
    `select count(*)::int as used
       from boards
      where space_id = $1 and owner_id = $2
        and archived_at is null and deleted_at is null`,
    [spaceId, userId],
  );
  return rows[0]?.used ?? 0;
}

/**
 * `GET /api/guest/claim-preview` —— 当前浏览器游客名下有多少块可转入，以及账号侧已用容量。
 *
 * `guestActive=false` 表示签名 `wb_gid` 缺失或已失效，前端据此不弹提示；
 * `canTransfer` 由服务端算好，前端只负责展示，避免两边口径漂移。
 */
guestRouter.get(
  '/guest/claim-preview',
  handle(async (req, res) => {
    const identity = identityOf(req);
    if (!identity.userId) throw new AppError(401, 'UNAUTHENTICATED', '请先登录');
    const space = await ensurePersonalSpace(identity.userId);
    const used = await countUsedBoards(pool, identity.userId, space.id);

    if (!identity.guestId) {
      res.json({
        count: 0,
        boards: [],
        guestActive: false,
        used,
        capacity: BOARD_CAPACITY,
        canTransfer: true,
      });
      return;
    }

    const { rows } = await pool.query<GuestBoardRow>(
      `select id, title, last_edited_at
         from boards
        where owner_guest_id = $1 and archived_at is null and deleted_at is null
        order by last_edited_at desc, id desc
        limit ${BOARD_CAPACITY}`,
      [identity.guestId],
    );

    res.json({
      count: rows.length,
      boards: rows.map((row) => ({ id: row.id, title: row.title, lastEditedAt: row.last_edited_at.toISOString() })),
      guestActive: true,
      used,
      capacity: BOARD_CAPACITY,
      canTransfer: used + rows.length <= BOARD_CAPACITY,
    });
  }),
);

/**
 * `POST /api/guest/claim` —— 单事务、全转或整体拒绝（v1.8）。
 *
 * - 不接收任何 id 列表：只认「会话 userId + 请求 cookie 里的 guestId」，不能转别人的板；
 * - 与建板/恢复共用同一把 advisory lock（`board-create:user:<id>:<space>`），先锁游客再锁用户，
 *   事务内重新计数，两个标签页同时提交也不会突破 12；
 * - `已用 + N > 12` → 429 `CAPACITY_FULL_TRANSFER`，一块都不转、不淘汰任何已有板；
 * - `wb_gid` 缺失/失效 → 409 `GUEST_COOKIE_INVALID`，不返回「转了 0 块」的假成功；
 * - 幂等：重复提交时游客名下已没有板，返回 `transferred: 0`；成功后不清 `wb_gid`，
 *   保证重放仍能给出同一个结果，而不是掉进 cookie 失效分支。
 */
guestRouter.post(
  '/guest/claim',
  handle(async (req, res) => {
    const identity = identityOf(req);
    if (!identity.userId) throw new AppError(401, 'UNAUTHENTICATED', '请先登录');
    const userId = identity.userId;
    const guestId = identity.guestId;
    if (!guestId) {
      throw new AppError(
        409,
        'GUEST_COOKIE_INVALID',
        '游客身份已失效，无法确认哪些临时板属于这台浏览器；请退出后以游客身份打开一次，再登录转入',
      );
    }

    const space = await ensurePersonalSpace(userId);
    const client = await pool.connect();
    try {
      await client.query('begin');
      // 固定顺序（先游客后用户）避免两笔 claim 互相等待；用户侧锁 key 与建板完全一致
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`board-create:guest:${guestId}`]);
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`board-create:user:${userId}:${space.id}`]);

      const { rows: guestRows } = await client.query<GuestBoardRow>(
        `select id, title, last_edited_at
           from boards
          where owner_guest_id = $1 and archived_at is null and deleted_at is null
          order by last_edited_at desc, id desc
          for update`,
        [guestId],
      );

      const used = await countUsedBoards(client, userId, space.id);
      if (guestRows.length === 0) {
        await client.query('commit');
        res.json({ transferred: 0, boards: [], used, capacity: BOARD_CAPACITY, userId });
        return;
      }

      if (used + guestRows.length > BOARD_CAPACITY) {
        await client.query('rollback');
        throw new AppError(
          429,
          'CAPACITY_FULL_TRANSFER',
          `空间已满，请先整理后再转入（已用 ${used} / ${BOARD_CAPACITY}，待转入 ${guestRows.length} 块）`,
        );
      }

      const ids = guestRows.map((row) => row.id);
      // owner_id / owner_guest_id 互斥约束：同一条 UPDATE 内先清后设；同时落到个人空间
      const { rows: moved } = await client.query<{ id: string; title: string }>(
        `update boards
            set owner_guest_id = null, owner_id = $1, space_id = $2
          where id = any($3::text[]) and owner_guest_id = $4
          returning id, title`,
        [userId, space.id, ids, guestId],
      );
      await client.query('commit');
      res.json({
        transferred: moved.length,
        boards: moved,
        used: used + moved.length,
        capacity: BOARD_CAPACITY,
        userId,
      });
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }),
);
