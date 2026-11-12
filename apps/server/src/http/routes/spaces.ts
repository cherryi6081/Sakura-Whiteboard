import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { can, type SpaceRole } from '@whiteboard/shared';
import { pool } from '../../infra/db.js';
import { AppError } from '../middlewares/error.js';
import { identityOf } from '../../auth/identity.js';
import { ensurePersonalSpace, resolveSpaceRole } from '../../domain/spaceAccess.js';

/**
 * 团队空间（设计稿 §09 P0）。
 *
 * - 本期只做「创建空间 + 邀请链接」，不做角色修改 / 移除成员 / 转让（P1）；
 * - 邀请链接 7 天有效、可撤销，加入时必须登录；
 * - 所有写接口先过 `resolveSpaceRole`，非成员统一 404，不泄露空间是否存在。
 */

export const spacesRouter = Router();

const handle =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

const spaceIdSchema = z.string().regex(/^sp_[A-Za-z0-9_-]{10,32}$/);
const inviteTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);

const createSpaceSchema = z.object({
  name: z.string().trim().min(1).max(40),
});

const inviteSchema = z.object({
  role: z.enum(['editor', 'viewer']).default('viewer'),
});

const INVITE_DAYS = 7;

type SpaceRow = {
  id: string;
  kind: 'personal' | 'team';
  name: string;
  role: SpaceRole;
  member_count: number;
  board_count: number;
};

function requireUser(req: Request): string {
  const { userId } = identityOf(req);
  if (!userId) throw new AppError(401, 'UNAUTHENTICATED', '请先登录');
  return userId;
}

/** 非成员 → 404；成员返回角色。 */
async function requireMember(spaceId: string, userId: string): Promise<SpaceRole> {
  const role = await resolveSpaceRole(spaceId, userId);
  if (!role) throw new AppError(404, 'NOT_FOUND', 'space not found');
  return role;
}

/** `GET /api/spaces` —— 个人空间 + 已加入的团队空间，个人空间恒在第一位。 */
spacesRouter.get(
  '/spaces',
  handle(async (req, res) => {
    const userId = requireUser(req);
    await ensurePersonalSpace(userId);

    const { rows } = await pool.query<SpaceRow>(
      `select s.id, s.kind, s.name, m.role,
              (select count(*)::int from space_members mm where mm.space_id = s.id) as member_count,
              (select count(*)::int from boards b
                where b.space_id = s.id and b.deleted_at is null and b.archived_at is null) as board_count
         from spaces s
         join space_members m on m.space_id = s.id and m.user_id = $1
        where s.deleted_at is null
        order by case s.kind when 'personal' then 0 else 1 end, s.created_at asc, s.id asc`,
      [userId],
    );

    res.json({
      spaces: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        name: row.name,
        role: row.role,
        memberCount: row.member_count,
        boardCount: row.board_count,
      })),
    });
  }),
);

/** `POST /api/spaces` —— 新建团队空间，创建者即所有者。 */
spacesRouter.post(
  '/spaces',
  handle(async (req, res) => {
    const userId = requireUser(req);
    const { name } = createSpaceSchema.parse(req.body ?? {});
    const id = `sp_${nanoid(12)}`;

    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into spaces (id, kind, name, owner_id) values ($1, 'team', $2, $3)`,
        [id, name, userId],
      );
      await client.query(
        `insert into space_members (space_id, user_id, role) values ($1, $2, 'owner')`,
        [id, userId],
      );
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }

    res.status(201).json({
      id,
      kind: 'team',
      name,
      role: 'owner',
      memberCount: 1,
      boardCount: 0,
    });
  }),
);

/** `GET /api/spaces/:id/members` —— 所有成员都能看成员列表（只读）。 */
spacesRouter.get(
  '/spaces/:id/members',
  handle(async (req, res) => {
    const userId = requireUser(req);
    const spaceId = spaceIdSchema.parse(req.params.id);
    await requireMember(spaceId, userId);

    const { rows } = await pool.query<{
      user_id: string;
      role: SpaceRole;
      joined_at: Date;
      display_name: string;
      email: string | null;
      color: string;
    }>(
      `select m.user_id, m.role, m.joined_at, u.display_name, u.email, u.color
         from space_members m
         join users u on u.id = m.user_id
        where m.space_id = $1
        order by case m.role when 'owner' then 0 else 1 end, m.joined_at asc`,
      [spaceId],
    );

    res.json({
      members: rows.map((row) => ({
        userId: row.user_id,
        displayName: row.display_name,
        email: row.email,
        color: row.color,
        role: row.role,
        joinedAt: row.joined_at.toISOString(),
      })),
    });
  }),
);

/** `POST /api/spaces/:id/invites` —— 所有者生成 7 天邀请链接（可多次使用）。 */
spacesRouter.post(
  '/spaces/:id/invites',
  handle(async (req, res) => {
    const userId = requireUser(req);
    const spaceId = spaceIdSchema.parse(req.params.id);
    const role = await requireMember(spaceId, userId);
    if (!can(role, 'invite')) throw new AppError(403, 'FORBIDDEN', '只有所有者能邀请成员');

    const { role: inviteRole } = inviteSchema.parse(req.body ?? {});
    const token = nanoid(24);
    const { rows } = await pool.query<{ expires_at: Date }>(
      `insert into space_invites (token, space_id, role, created_by)
       values ($1, $2, $3, $4)
       returning expires_at`,
      [token, spaceId, inviteRole, userId],
    );

    res.status(201).json({
      token,
      role: inviteRole,
      url: `/join/${token}`,
      expiresAt: rows[0]?.expires_at.toISOString() ?? null,
      expiresInDays: INVITE_DAYS,
    });
  }),
);

/** `DELETE /api/spaces/:id/invites/:token` —— 撤销邀请（幂等）。 */
spacesRouter.delete(
  '/spaces/:id/invites/:token',
  handle(async (req, res) => {
    const userId = requireUser(req);
    const spaceId = spaceIdSchema.parse(req.params.id);
    const token = inviteTokenSchema.parse(req.params.token);
    const role = await requireMember(spaceId, userId);
    if (!can(role, 'invite')) throw new AppError(403, 'FORBIDDEN', '只有所有者能撤销邀请');

    await pool.query(
      `update space_invites set revoked_at = coalesce(revoked_at, now())
        where space_id = $1 and token = $2`,
      [spaceId, token],
    );
    res.json({ token, revoked: true });
  }),
);

/** `POST /api/invites/:token/accept` —— 登录后加入空间；重复打开不重复加入。 */
spacesRouter.post(
  '/invites/:token/accept',
  handle(async (req, res) => {
    const userId = requireUser(req);
    const token = inviteTokenSchema.parse(req.params.token);

    const { rows } = await pool.query<{
      space_id: string;
      role: 'editor' | 'viewer';
      expires_at: Date;
      revoked_at: Date | null;
      max_uses: number | null;
      used_count: number;
      space_name: string;
      deleted_at: Date | null;
    }>(
      `select i.space_id, i.role, i.expires_at, i.revoked_at, i.max_uses, i.used_count,
              s.name as space_name, s.deleted_at
         from space_invites i
         join spaces s on s.id = i.space_id
        where i.token = $1`,
      [token],
    );
    const invite = rows[0];
    if (!invite || invite.deleted_at) throw new AppError(404, 'NOT_FOUND', '邀请链接无效');
    if (invite.revoked_at || invite.expires_at.getTime() <= Date.now()) {
      throw new AppError(410, 'LINK_EXPIRED', '邀请链接已失效');
    }
    if (invite.max_uses !== null && invite.used_count >= invite.max_uses) {
      throw new AppError(410, 'LINK_EXPIRED', '邀请链接已用完');
    }

    const existing = await resolveSpaceRole(invite.space_id, userId);
    if (existing) {
      res.json({ spaceId: invite.space_id, spaceName: invite.space_name, role: existing, alreadyMember: true });
      return;
    }

    await pool.query(
      `insert into space_members (space_id, user_id, role, invited_by)
       values ($1, $2, $3, $4)
       on conflict (space_id, user_id) do nothing`,
      [invite.space_id, userId, invite.role, null],
    );
    await pool.query('update space_invites set used_count = used_count + 1 where token = $1', [token]);

    res.json({ spaceId: invite.space_id, spaceName: invite.space_name, role: invite.role, alreadyMember: false });
  }),
);
