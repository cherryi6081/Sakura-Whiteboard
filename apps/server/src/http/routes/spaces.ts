import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { can, type SpaceRole } from '@whiteboard/shared';
import { pool } from '../../infra/db.js';
import { AppError } from '../middlewares/error.js';
import { identityOf } from '../../auth/identity.js';
import { TRASH_RETENTION_DAYS } from '../../domain/retention.js';
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

const transferSchema = z.object({
  userId: z.string().uuid(),
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

/* ------------------------------------------------------------------------------------------
 * 生命周期：退出 / 转让 / 解散
 *
 * 规则（页面文案与此一致）：
 * - 个人空间是账号私有空间，不能退出或解散；
 * - 编辑者 / 只读成员可随时退出，自己创建的白板留在空间里（归属空间，不随人走）；
 * - 所有者有其它成员时必须先转让，唯一成员时必须显式解散，避免「退出」静默删空间；
 * - 解散只允许所有者：白板全部迁到所有者个人空间并进回收站，回收站恢复沿用 12 块容量规则。
 * ---------------------------------------------------------------------------------------- */

type LockedSpaceRow = {
  kind: 'personal' | 'team';
  name: string;
  owner_id: string;
  role: SpaceRole;
};

/** 事务内锁住空间与当前成员行；非成员返回 null（对外统一 404）。 */
async function lockSpaceMembership(
  client: PoolClient,
  spaceId: string,
  userId: string,
): Promise<LockedSpaceRow | null> {
  const { rows } = await client.query<LockedSpaceRow>(
    `select s.kind, s.name, s.owner_id, m.role
       from spaces s
       join space_members m on m.space_id = s.id and m.user_id = $2
      where s.id = $1 and s.deleted_at is null
      for update of s, m`,
    [spaceId, userId],
  );
  return rows[0] ?? null;
}

/** `POST /api/spaces/:id/leave` —— 退出团队空间；所有者必须先转让或解散。 */
spacesRouter.post(
  '/spaces/:id/leave',
  handle(async (req, res) => {
    const userId = requireUser(req);
    const spaceId = spaceIdSchema.parse(req.params.id);

    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`space:${spaceId}`]);

      const space = await lockSpaceMembership(client, spaceId, userId);
      if (!space) throw new AppError(404, 'NOT_FOUND', 'space not found');
      if (space.kind === 'personal') {
        throw new AppError(400, 'CANNOT_LEAVE_PERSONAL', '个人空间不能退出');
      }

      if (space.role === 'owner') {
        const { rows } = await client.query<{ count: number }>(
          'select count(*)::int as count from space_members where space_id = $1',
          [spaceId],
        );
        const memberCount = rows[0]?.count ?? 0;
        if (memberCount > 1) {
          throw new AppError(409, 'OWNER_MUST_TRANSFER', '请先把所有权转让给其他成员，再退出空间');
        }
        throw new AppError(409, 'LAST_OWNER_USE_DISSOLVE', '你是唯一成员，请使用「解散空间」');
      }

      // 退出不带走白板：板属于空间，仍在原处供其他成员使用
      const { rows: keptRows } = await client.query<{ count: number }>(
        `select count(*)::int as count from boards
          where space_id = $1 and owner_id = $2
            and deleted_at is null and archived_at is null`,
        [spaceId, userId],
      );
      // 曾经的所有者可能留下邀请链接：退出时一并吊销，避免绕开「退出」再把自己加回来
      await client.query(
        `update space_invites set revoked_at = coalesce(revoked_at, now())
          where space_id = $1 and created_by = $2 and revoked_at is null`,
        [spaceId, userId],
      );
      await client.query('delete from space_members where space_id = $1 and user_id = $2', [spaceId, userId]);
      await client.query('commit');

      res.json({ spaceId, mode: 'left', boardsKept: keptRows[0]?.count ?? 0 });
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }),
);

/** `PUT /api/spaces/:id/owner` —— 所有者把所有权转让给现有成员，自己降为编辑者。 */
spacesRouter.put(
  '/spaces/:id/owner',
  handle(async (req, res) => {
    const userId = requireUser(req);
    const spaceId = spaceIdSchema.parse(req.params.id);
    const { userId: targetId } = transferSchema.parse(req.body ?? {});

    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`space:${spaceId}`]);

      const space = await lockSpaceMembership(client, spaceId, userId);
      if (!space) throw new AppError(404, 'NOT_FOUND', 'space not found');
      if (space.kind === 'personal') {
        throw new AppError(400, 'CANNOT_TRANSFER_PERSONAL', '个人空间不能转让');
      }
      if (space.role !== 'owner') throw new AppError(403, 'FORBIDDEN', '只有所有者能转让空间');
      if (targetId === userId) throw new AppError(400, 'ALREADY_OWNER', '你已经是所有者');

      const { rows: targetRows } = await client.query<{ role: SpaceRole }>(
        'select role from space_members where space_id = $1 and user_id = $2 for update',
        [spaceId, targetId],
      );
      if (!targetRows[0]) throw new AppError(404, 'NOT_FOUND', '目标成员不在这个空间里');

      // 唯一部分索引 space_members_one_owner 不允许同一语句出现两个 owner，分两步降级再升级
      await client.query(
        `update space_members set role = 'editor' where space_id = $1 and user_id = $2`,
        [spaceId, userId],
      );
      await client.query(
        `update space_members set role = 'owner' where space_id = $1 and user_id = $2`,
        [spaceId, targetId],
      );
      await client.query('update spaces set owner_id = $2, updated_at = now() where id = $1', [spaceId, targetId]);
      await client.query('commit');

      res.json({
        spaceId,
        ownerId: targetId,
        previousOwnerId: userId,
        previousOwnerRole: 'editor',
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
 * `DELETE /api/spaces/:id` —— 解散团队空间（仅所有者）。
 *
 * 白板不物理删除：全部迁到所有者个人空间并置为回收站，30 天后由既有回收站任务清理；
 * 恢复时走既有 12 块容量与「恢复并替换」流程，因此这里不做任何容量判断。
 */
spacesRouter.delete(
  '/spaces/:id',
  handle(async (req, res) => {
    const userId = requireUser(req);
    const spaceId = spaceIdSchema.parse(req.params.id);
    // 事务外先确保个人空间存在；失败只会多一个空空间，不影响解散本身
    const personal = await ensurePersonalSpace(userId);

    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`space:${spaceId}`]);

      const space = await lockSpaceMembership(client, spaceId, userId);
      if (!space) throw new AppError(404, 'NOT_FOUND', 'space not found');
      if (space.kind === 'personal') {
        throw new AppError(400, 'CANNOT_DELETE_PERSONAL', '个人空间不能解散');
      }
      if (space.role !== 'owner') throw new AppError(403, 'FORBIDDEN', '只有所有者能解散空间');

      const { rows: countRows } = await client.query<{ active: number; trashed: number }>(
        `select count(*) filter (where deleted_at is null and archived_at is null)::int as active,
                count(*) filter (where deleted_at is not null)::int as trashed
           from boards where space_id = $1`,
        [spaceId],
      );
      const activeCount = countRows[0]?.active ?? 0;
      const trashedCount = countRows[0]?.trashed ?? 0;

      const { rows: movedRows } = await client.query<{ id: string }>(
        `update boards
            set space_id = $2, owner_id = $3, pinned_at = null,
                deleted_at = coalesce(deleted_at, now())
          where space_id = $1
          returning id`,
        [spaceId, personal.id, userId],
      );
      const movedIds = movedRows.map((row) => row.id);
      if (movedIds.length > 0) {
        // rank 是「用户 + 板」的个性化顺序；换到个人空间后旧 rank 会把恢复后的板顶到前面
        await client.query('delete from board_user_order where board_id = any($1::text[])', [movedIds]);
      }

      await client.query(
        `update space_invites set revoked_at = coalesce(revoked_at, now())
          where space_id = $1 and revoked_at is null`,
        [spaceId],
      );
      await client.query('delete from space_members where space_id = $1', [spaceId]);
      await client.query('update spaces set deleted_at = now(), updated_at = now() where id = $1', [spaceId]);
      await client.query('commit');

      console.info('[spaces] dissolved', {
        spaceId,
        ownerId: userId,
        boardsMoved: movedIds.length,
        boardsTrashed: activeCount,
      });

      res.json({
        spaceId,
        mode: 'dissolved',
        boardsMoved: movedIds.length,
        boardsTrashed: activeCount,
        boardsAlreadyTrashed: trashedCount,
        retentionDays: TRASH_RETENTION_DAYS,
        purgeAt: new Date(Date.now() + TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString(),
      });
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
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
