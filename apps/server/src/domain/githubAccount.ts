import { GithubOAuthError, type GithubProfile } from '../auth/githubOAuth.js';
import { pool } from '../infra/db.js';

/**
 * GitHub 登录的账号落库口径（开发文档 §13.1）：
 * 1. 已绑定 (provider, provider_user_id) → 直接用该用户；
 * 2. 未绑定但 GitHub 已验证邮箱命中现有账号 → 把绑定挂到老用户，不新建；
 * 3. 都没有 → 新建用户（邮箱视为已验证）并绑定。
 *
 * `oauth_accounts.unique(provider, provider_user_id)` 是并发兜底：
 * 撞唯一键时回滚重试一次，第二次必然走「已绑定」分支。
 */
function displayNameFor(profile: GithubProfile): string {
  const raw = (profile.name || profile.login || '').replace(/[\u0000-\u001f]/g, '').trim();
  const characters = Array.from(raw).slice(0, 24).join('');
  if (Array.from(characters).length >= 2) return characters;
  const fallback = `GitHub ${profile.login}`.replace(/[\u0000-\u001f]/g, '').trim();
  return Array.from(fallback).slice(0, 24).join('') || 'GitHub 用户';
}

async function attemptLogin(profile: GithubProfile): Promise<{ userId: string }> {
  const client = await pool.connect();
  try {
    await client.query('begin');

    const binding = await client.query<{ user_id: string; status: string }>(
      `select o.user_id, u.status
         from oauth_accounts o
         join users u on u.id = o.user_id
        where o.provider = 'github' and o.provider_user_id = $1
          for update of o`,
      [profile.id],
    );

    let userId = binding.rows[0]?.user_id ?? null;
    if (userId && binding.rows[0]!.status !== 'active') {
      throw new GithubOAuthError('account_disabled');
    }

    let createdId: string | null = null;
    if (!userId) {
      const byEmail = await client.query<{ id: string; status: string }>(
        'select id, status from users where email = $1',
        [profile.email],
      );
      const existing = byEmail.rows[0];
      if (existing) {
        if (existing.status !== 'active') throw new GithubOAuthError('account_disabled');
        userId = existing.id;
        await client.query(
          'update users set email_verified_at = coalesce(email_verified_at, now()) where id = $1',
          [userId],
        );
      } else {
        const inserted = await client.query<{ id: string }>(
          `insert into users (email, display_name, avatar_url, email_verified_at)
           values ($1, $2, $3, now())
           returning id`,
          [profile.email, displayNameFor(profile), profile.avatarUrl],
        );
        userId = inserted.rows[0]!.id;
        createdId = userId;
      }
    }

    const upserted = await client.query<{ user_id: string }>(
      `insert into oauth_accounts
         (user_id, provider, provider_user_id, provider_email, provider_email_verified, scopes, last_used_at)
       values ($1, 'github', $2, $3, true, $4, now())
       on conflict (provider, provider_user_id) do update
         set provider_email = excluded.provider_email,
             provider_email_verified = excluded.provider_email_verified,
             scopes = excluded.scopes,
             last_used_at = now()
       returning user_id`,
      [userId, profile.id, profile.email, 'read:user user:email'],
    );
    const finalUserId = upserted.rows[0]!.user_id;

    if (createdId && finalUserId !== createdId) {
      // 并发下别的请求先绑定了这个 GitHub 账号：刚建的空用户回滚掉
      await client.query('delete from users where id = $1', [createdId]);
    }
    if (finalUserId !== userId) {
      const owner = await client.query<{ status: string }>('select status from users where id = $1', [finalUserId]);
      if (owner.rows[0]?.status !== 'active') throw new GithubOAuthError('account_disabled');
    }

    await client.query(
      'update users set last_login_at = now(), avatar_url = coalesce(avatar_url, $2) where id = $1',
      [finalUserId, profile.avatarUrl],
    );
    await client.query('commit');
    return { userId: finalUserId };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function loginWithGithub(profile: GithubProfile): Promise<{ userId: string }> {
  try {
    return await attemptLogin(profile);
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      return attemptLogin(profile);
    }
    throw error;
  }
}

/**
 * 登录态绑定 GitHub（不建号、不改邮箱、不碰邮箱验证状态）。
 *
 * 并发口径与登录一致：`(provider, provider_user_id)` 唯一键兜底；
 * 已绑定到同一用户视为幂等成功，已绑定到别人则明确拒绝。
 */

export type GithubBindingErrorCode = 'github_already_linked' | 'account_disabled';

export class GithubBindingError extends Error {
  constructor(
    public readonly code: GithubBindingErrorCode,
    message: string = code,
  ) {
    super(message);
  }
}

async function attemptBind(userId: string, profile: GithubProfile): Promise<{ alreadyLinked: boolean }> {
  const client = await pool.connect();
  try {
    await client.query('begin');

    const user = await client.query<{ status: string }>('select status from users where id = $1 for update', [userId]);
    if (user.rows[0]?.status !== 'active') throw new GithubBindingError('account_disabled');

    const binding = await client.query<{ user_id: string }>(
      `select user_id from oauth_accounts
        where provider = 'github' and provider_user_id = $1
          for update`,
      [profile.id],
    );
    const owner = binding.rows[0]?.user_id;
    if (owner && owner !== userId) throw new GithubBindingError('github_already_linked');

    if (owner === userId) {
      await client.query(
        `update oauth_accounts
            set provider_email = $2,
                provider_email_verified = true,
                scopes = $3,
                last_used_at = now()
          where provider = 'github' and provider_user_id = $1`,
        [profile.id, profile.email, 'read:user user:email'],
      );
    } else {
      await client.query(
        `insert into oauth_accounts
           (user_id, provider, provider_user_id, provider_email, provider_email_verified, scopes, last_used_at)
         values ($1, 'github', $2, $3, true, $4, now())`,
        [userId, profile.id, profile.email, 'read:user user:email'],
      );
    }

    await client.query('commit');
    return { alreadyLinked: owner === userId };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function bindGithubAccount(
  userId: string,
  profile: GithubProfile,
): Promise<{ alreadyLinked: boolean }> {
  try {
    return await attemptBind(userId, profile);
  } catch (error) {
    if ((error as { code?: string }).code !== '23505') throw error;
    // 并发下别人先绑定了同一个 GitHub 账号：重新读一次归属再决定
    const { rows } = await pool.query<{ user_id: string }>(
      `select user_id from oauth_accounts where provider = 'github' and provider_user_id = $1`,
      [profile.id],
    );
    if (rows[0]?.user_id === userId) return { alreadyLinked: true };
    throw new GithubBindingError('github_already_linked');
  }
}
