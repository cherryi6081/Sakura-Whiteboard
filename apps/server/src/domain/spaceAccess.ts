import type { SpaceRole } from '@whiteboard/shared';
import { nanoid } from 'nanoid';
import { pool } from '../infra/db.js';

/**
 * 空间级授权（设计稿 §05 安全边界）。
 *
 * `space_members` 是唯一权限来源；个人空间由「一人一条」的部分唯一索引兜底。
 * 非成员一律返回 `null`，调用方统一映射成 404 —— 不暴露空间是否存在。
 */
export async function resolveSpaceRole(spaceId: string, userId: string | null): Promise<SpaceRole | null> {
  if (!userId) return null;
  const { rows } = await pool.query<{ role: SpaceRole }>(
    `select m.role
       from space_members m
       join spaces s on s.id = m.space_id
      where m.space_id = $1 and m.user_id = $2 and s.deleted_at is null`,
    [spaceId, userId],
  );
  return rows[0]?.role ?? null;
}

export type PersonalSpace = { id: string; name: string };

/**
 * 取（必要时创建）用户的个人空间。
 *
 * 放在读路径上而不是注册流程里：老账号、并发首请求都能自愈；
 * `on conflict do nothing` + 二次查询处理两个请求同时建空间的竞态。
 */
export async function ensurePersonalSpace(userId: string): Promise<PersonalSpace> {
  const find = () =>
    pool.query<PersonalSpace>(
      `select id, name from spaces
        where owner_id = $1 and kind = 'personal' and deleted_at is null
        limit 1`,
      [userId],
    );

  const existing = await find();
  if (existing.rows[0]) return existing.rows[0];

  const id = `sp_${nanoid(12)}`;
  await pool.query(
    `insert into spaces (id, kind, name, owner_id)
     select $1, 'personal', left(display_name, 40), id from users where id = $2
     on conflict do nothing`,
    [id, userId],
  );

  const created = await find();
  const space = created.rows[0];
  if (!space) throw new Error('personal space 创建失败');

  await pool.query(
    `insert into space_members (space_id, user_id, role) values ($1, $2, 'owner')
     on conflict (space_id, user_id) do nothing`,
    [space.id, userId],
  );
  return space;
}
