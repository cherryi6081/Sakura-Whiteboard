import type { PoolClient } from 'pg';
import { pool } from '../infra/db.js';
import { logger } from '../infra/logger.js';
import { storage } from '../infra/storage.js';
import { AppError } from '../http/middlewares/error.js';
import { ensurePersonalSpace } from './spaceAccess.js';

/**
 * 销号（开发文档 §7 / §5.5）。
 *
 * 口径（已与产品确认）：
 * - `users` 行保留并置 `status='disabled'`，昵称固定「已注销用户」，邮箱换成
 *   `deleted+<userId>@deleted.invalid`——`.invalid` 是保留 TLD，不会与真实邮箱冲突；
 *   原邮箱列值被替换后唯一索引自然释放，同一邮箱可以重新注册。
 * - 业务数据**物理删除**：该用户名下的白板及其 op / 快照 / 资产 / 分享链接 / 白板成员关系，
 *   以及他在其它板/空间里的成员关系。他人板上的历史 op 与图片保留，否则会破坏别人的白板。
 * - 团队空间所有者：空间里还有其它成员时拒绝销号（409），要求先转让或解散；
 *   只剩自己时按「解散」处理——他人白板迁回各自个人空间并进回收站，然后删除空间行。
 */

export const DELETED_DISPLAY_NAME = '已注销用户';

export const deletedEmailFor = (userId: string): string => `deleted+${userId}@deleted.invalid`;

type OwnedTeamSpace = { id: string; name: string; members: number };

/** 事务外预检：避免已经删了一半才发现有空间没转让。 */
async function ownedTeamSpaces(userId: string): Promise<OwnedTeamSpace[]> {
  const { rows } = await pool.query<OwnedTeamSpace>(
    `select s.id, s.name,
            (select count(*)::int from space_members m where m.space_id = s.id) as members
       from spaces s
      where s.owner_id = $1 and s.kind = 'team' and s.deleted_at is null
      order by s.created_at asc`,
    [userId],
  );
  return rows;
}

function ownershipBlocked(spaces: OwnedTeamSpace[]): AppError | null {
  const blocking = spaces.filter((space) => space.members > 1);
  if (blocking.length === 0) return null;
  const names = blocking.slice(0, 3).map((space) => `「${space.name}」`).join('、');
  const suffix = blocking.length > 3 ? `等 ${blocking.length} 个空间` : '';
  return new AppError(
    409,
    'SPACE_OWNERSHIP_REQUIRED',
    `请先转让或解散团队空间后再注销：${names}${suffix}`,
  );
}

/** 该用户白板上的图片对象键（行随白板级联删除，文件需要单独清）。 */
async function storageKeysOfOwnedBoards(userId: string): Promise<string[]> {
  const { rows } = await pool.query<{ storage_key: string }>(
    `select a.storage_key
       from assets a
       join boards b on b.id = a.board_id
      where b.owner_id = $1`,
    [userId],
  );
  return rows.map((row) => row.storage_key);
}

type DissolvePlan = {
  spaceId: string;
  /** 他人白板 -> 作者个人空间；事务外先建好，避免事务里再用另一条连接写库。 */
  personalByOwner: Map<string, string>;
};

async function planDissolve(spaces: OwnedTeamSpace[], userId: string): Promise<DissolvePlan[]> {
  const plans: DissolvePlan[] = [];
  for (const space of spaces) {
    const { rows } = await pool.query<{ owner_id: string }>(
      `select distinct owner_id from boards where space_id = $1 and owner_id <> $2`,
      [space.id, userId],
    );
    const personalByOwner = new Map<string, string>();
    for (const row of rows) {
      const personal = await ensurePersonalSpace(row.owner_id);
      personalByOwner.set(row.owner_id, personal.id);
    }
    plans.push({ spaceId: space.id, personalByOwner });
  }
  return plans;
}

/** 只剩自己的团队空间：把他人白板迁回作者个人空间并进回收站，再删空间行。 */
async function dissolveSoloTeamSpace(client: PoolClient, plan: DissolvePlan): Promise<void> {
  for (const [ownerId, personalSpaceId] of plan.personalByOwner) {
    const moved = await client.query<{ id: string }>(
      `update boards
          set space_id = $2, pinned_at = null, deleted_at = coalesce(deleted_at, now())
        where space_id = $1 and owner_id = $3
        returning id`,
      [plan.spaceId, personalSpaceId, ownerId],
    );
    const ids = moved.rows.map((item) => item.id);
    if (ids.length > 0) {
      await client.query('delete from board_user_order where board_id = any($1::text[])', [ids]);
    }
  }

  await client.query(
    `update space_invites set revoked_at = coalesce(revoked_at, now())
      where space_id = $1 and revoked_at is null`,
    [plan.spaceId],
  );
  await client.query('delete from space_members where space_id = $1', [plan.spaceId]);
  await client.query('delete from spaces where id = $1', [plan.spaceId]);
}

async function purgeInTransaction(userId: string, plans: DissolvePlan[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    // 同一账号的并发销号串行化
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`account:${userId}`]);

    // 事务内再确认一次团队空间成员数（防止预检后被邀请进人）
    const recheck = await client.query<{ members: number }>(
      `select (select count(*)::int from space_members m where m.space_id = s.id) as members
         from spaces s
        where s.owner_id = $1 and s.kind = 'team' and s.deleted_at is null
        for update of s`,
      [userId],
    );
    if (recheck.rows.some((row) => row.members > 1)) {
      await client.query('rollback');
      throw new AppError(409, 'SPACE_OWNERSHIP_REQUIRED', '团队空间里还有其他成员，请先转让或解散');
    }

    for (const plan of plans) {
      await dissolveSoloTeamSpace(client, plan);
    }

    // 白板级联清掉：board_ops / board_snapshots / assets / share_links / board_members / board_user_order
    await client.query('delete from boards where owner_id = $1', [userId]);

    // 他人板上的成员关系、其它空间的成员关系
    await client.query('delete from board_members where user_id = $1', [userId]);
    await client.query('delete from space_members where user_id = $1', [userId]);

    // 个人空间 + 历史解散留下的空间墓碑（deleted_at 已置）一并物理删除，
    // 避免账号停用后还挂着没有任何成员的空间行
    await client.query('delete from spaces where owner_id = $1', [userId]);

    // 邀请链接是临时凭据：本人发起的全部立即吊销（本人拥有的空间已随空间删除）
    await client.query(
      `update space_invites set revoked_at = coalesce(revoked_at, now())
        where created_by = $1 and revoked_at is null`,
      [userId],
    );

    await client.query('delete from board_user_order where user_id = $1', [userId]);
    await client.query('delete from board_user_settings where user_id = $1', [userId]);
    await client.query('delete from credentials where user_id = $1', [userId]);
    await client.query('delete from oauth_accounts where user_id = $1', [userId]);

    await client.query(
      `update users
          set status = 'disabled',
              display_name = $2,
              email = $3,
              avatar_url = null,
              email_verified_at = null
        where id = $1`,
      [userId, DELETED_DISPLAY_NAME, deletedEmailFor(userId)],
    );

    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function purgeAccount(userId: string): Promise<void> {
  const spaces = await ownedTeamSpaces(userId);
  const blocked = ownershipBlocked(spaces);
  if (blocked) throw blocked;

  const plans = await planDissolve(spaces, userId);
  const keys = await storageKeysOfOwnedBoards(userId);
  await purgeInTransaction(userId, plans);

  // 文件删除放事务之后：失败只会留下无主对象，不影响账号是否已注销
  const results = await Promise.allSettled(keys.map((key) => storage.delete(key)));
  const failed = results.filter((result) => result.status === 'rejected').length;
  if (failed > 0) logger.warn({ userId, failed, total: keys.length }, 'account purge: storage delete partially failed');
}
