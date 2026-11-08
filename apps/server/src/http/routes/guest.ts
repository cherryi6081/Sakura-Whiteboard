import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { pool } from '../../infra/db.js';
import { AppError } from '../middlewares/error.js';
import { identityOf } from '../../auth/identity.js';
import { clearGuestCookie, issueGuestCookie } from '../../auth/guestCookie.js';

/**
 * 游客接口（开发文档 §7.1.7）。
 *
 * - `GET /api/guest/me`：前端启动时调用一次，确保签名 `wb_gid` 已下发（HttpOnly，JS 读不到），
 *   并返回游客徽标与配额进度。已登录时仍返回 guestId —— 它是"待认领临时板"的凭据。
 * - `GET /api/guest/claim-preview` / `POST /api/guest/claim`：需会话；认领的凭据是
 *   **会话里的 userId + 当前请求 cookie 里的 guestId**，不接受任何跨用户传递。
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
      `select count(*) filter (where archived_at is null)::int as unarchived,
              count(*) filter (where created_at > now() - interval '24 hours')::int as created_24h
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

guestRouter.get(
  '/guest/claim-preview',
  handle(async (req, res) => {
    const identity = identityOf(req);
    if (!identity.userId) throw new AppError(401, 'UNAUTHENTICATED', '请先登录');
    if (!identity.guestId) {
      res.json({ count: 0, boards: [] });
      return;
    }

    const { rows } = await pool.query<GuestBoardRow>(
      `select id, title, last_edited_at
         from boards
        where owner_guest_id = $1 and archived_at is null
        order by last_edited_at desc
        limit 50`,
      [identity.guestId],
    );

    res.json({
      count: rows.length,
      boards: rows.map((row) => ({ id: row.id, title: row.title, lastEditedAt: row.last_edited_at.toISOString() })),
    });
  }),
);

const claimSchema = z.object({
  boardIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{12}$/)).max(50).optional(),
});

type ClaimRow = { id: string; title: string; owner_id: string | null; owner_guest_id: string | null };

/**
 * `POST /api/guest/claim` —— 单事务、全量成功或全量失败、幂等（§4.5 / §8.6.3）。
 *
 * - 入参缺省 = 当前 guestId 名下的全部未归档板；
 * - 任一块已归其他用户 / 其他游客 → **整笔回滚 + 409**，不静默跳过；
 * - 已属于当前用户的板视为幂等命中（跳过），因此重复调用返回 `transferred:0`；
 * - `owner_id` 与 `owner_guest_id` 在同一条 UPDATE 里先清后设，满足互斥约束。
 */
guestRouter.post(
  '/guest/claim',
  handle(async (req, res) => {
    const identity = identityOf(req);
    if (!identity.userId) throw new AppError(401, 'UNAUTHENTICATED', '请先登录');
    const { boardIds } = claimSchema.parse(req.body ?? {});

    const guestId = identity.guestId;
    if (!guestId) {
      res.json({ transferred: 0, boards: [] });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('begin');

      const { rows: owned } = await client.query<GuestBoardRow>(
        `select id, title, last_edited_at
           from boards
          where owner_guest_id = $1 and archived_at is null
          for update`,
        [guestId],
      );
      const ownedIds = new Set(owned.map((row) => row.id));
      const targets = boardIds ?? owned.map((row) => row.id);

      // 逐个校验：任一块不属于当前游客（且不是"已归我"的幂等重放）就整笔回滚
      for (const id of targets) {
        if (ownedIds.has(id)) continue;
        const { rows } = await client.query<ClaimRow>(
          'select id, title, owner_id, owner_guest_id from boards where id = $1 for update',
          [id],
        );
        const row = rows[0];
        const mineAlready = row && row.owner_id === identity.userId && row.owner_guest_id === null;
        if (!mineAlready) {
          await client.query('rollback');
          throw new AppError(409, 'CLAIM_CONFLICT', '有白板不属于当前游客或已被其他账号认领，本次未转移任何白板');
        }
      }

      const toTransfer = targets.filter((id) => ownedIds.has(id));
      const transferred: { id: string; title: string }[] = [];
      for (const id of toTransfer) {
        const { rows } = await client.query<{ id: string; title: string }>(
          `update boards
              set owner_guest_id = null, owner_id = $1
            where id = $2 and owner_guest_id = $3
            returning id, title`,
          [identity.userId, id, guestId],
        );
        const row = rows[0];
        if (row) transferred.push({ id: row.id, title: row.title });
      }

      await client.query('commit');
      if (transferred.length > 0) clearGuestCookie(res);
      res.json({ transferred: transferred.length, boards: transferred });
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }),
);
