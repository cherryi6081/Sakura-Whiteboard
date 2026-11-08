import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { pool } from '../../infra/db.js';
import { identityOf } from '../../auth/identity.js';
import { issueGuestCookie } from '../../auth/guestCookie.js';

/**
 * `GET /api/guest/me`（开发文档 §7.1.7）。
 *
 * 前端启动时调用一次：确保签名 `wb_gid` 已下发（HttpOnly，JS 读不到），并返回游客徽标
 * 需要的信息与配额进度。已登录时仍然返回 guestId —— 它是"待认领临时板"的凭据。
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
