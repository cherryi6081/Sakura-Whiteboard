import { OAuthError, type OAuthProvider } from '../auth/oauthShared.js';
import { pool } from '../infra/db.js';

/**
 * 第三方登录的账号落库口径（GitHub / Google 共用，开发文档 §13.1）：
 * 1. 已绑定 (provider, provider_user_id) → 直接用该用户；
 * 2. 未绑定但第三方已验证邮箱命中现有账号 → 把绑定挂到老用户，不新建；
 * 3. 都没有 → 新建用户（邮箱视为已验证）并绑定。
 *
 * 同邮箱合并规则对两家 provider 完全一致，不按 provider 另立口径。
 * `oauth_accounts.unique(provider, provider_user_id)` 是并发兜底：
 * 撞唯一键时回滚重试一次，第二次必然走「已绑定」分支。
 */

export type OAuthProfile = {
  provider: OAuthProvider;
  id: string;
  /** 展示兜底用的账号名（Google 用邮箱前缀）。 */
  login: string;
  name: string | null;
  avatarUrl: string | null;
  email: string;
  scopes: string;
};

const PROVIDER_LABEL: Record<OAuthProvider, string> = {
  github: 'GitHub',
  google: 'Google',
};

function displayNameFor(profile: OAuthProfile): string {
  const raw = (profile.name || profile.login || '').replace(/[\u0000-\u001f]/g, '').trim();
  const characters = Array.from(raw).slice(0, 24).join('');
  if (Array.from(characters).length >= 2) return characters;
  const fallback = `${PROVIDER_LABEL[profile.provider]} ${profile.login}`.replace(/[\u0000-\u001f]/g, '').trim();
  return Array.from(fallback).slice(0, 24).join('') || `${PROVIDER_LABEL[profile.provider]} 用户`;
}

async function attemptLogin(profile: OAuthProfile): Promise<{ userId: string }> {
  const client = await pool.connect();
  try {
    await client.query('begin');

    const binding = await client.query<{ user_id: string; status: string }>(
      `select o.user_id, u.status
         from oauth_accounts o
         join users u on u.id = o.user_id
        where o.provider = $1 and o.provider_user_id = $2
          for update of o`,
      [profile.provider, profile.id],
    );

    let userId = binding.rows[0]?.user_id ?? null;
    if (userId && binding.rows[0]!.status !== 'active') {
      throw new OAuthError('account_disabled');
    }

    let createdId: string | null = null;
    if (!userId) {
      const byEmail = await client.query<{ id: string; status: string }>(
        'select id, status from users where email = $1',
        [profile.email],
      );
      const existing = byEmail.rows[0];
      if (existing) {
        if (existing.status !== 'active') throw new OAuthError('account_disabled');
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
       values ($1, $2, $3, $4, true, $5, now())
       on conflict (provider, provider_user_id) do update
         set provider_email = excluded.provider_email,
             provider_email_verified = excluded.provider_email_verified,
             scopes = excluded.scopes,
             last_used_at = now()
       returning user_id`,
      [userId, profile.provider, profile.id, profile.email, profile.scopes],
    );
    const finalUserId = upserted.rows[0]!.user_id;

    if (createdId && finalUserId !== createdId) {
      // 并发下别的请求先绑定了这个第三方账号：刚建的空用户回滚掉
      await client.query('delete from users where id = $1', [createdId]);
    }
    if (finalUserId !== userId) {
      const owner = await client.query<{ status: string }>('select status from users where id = $1', [finalUserId]);
      if (owner.rows[0]?.status !== 'active') throw new OAuthError('account_disabled');
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

export async function loginWithOAuth(profile: OAuthProfile): Promise<{ userId: string }> {
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
 * 登录态绑定第三方账号（不建号、不改邮箱、不碰邮箱验证状态）。
 *
 * 并发口径与登录一致：`(provider, provider_user_id)` 唯一键兜底；
 * 已绑定到同一用户视为幂等成功，已绑定到别人则明确拒绝。
 */

export type OAuthBindingErrorCode = 'github_already_linked' | 'google_already_linked' | 'account_disabled';

export class OAuthBindingError extends Error {
  constructor(
    public readonly code: OAuthBindingErrorCode,
    message: string = code,
  ) {
    super(message);
  }
}

function alreadyLinkedCode(provider: OAuthProvider): OAuthBindingErrorCode {
  return provider === 'google' ? 'google_already_linked' : 'github_already_linked';
}

async function attemptBind(userId: string, profile: OAuthProfile): Promise<{ alreadyLinked: boolean }> {
  const client = await pool.connect();
  try {
    await client.query('begin');

    const user = await client.query<{ status: string }>('select status from users where id = $1 for update', [userId]);
    if (user.rows[0]?.status !== 'active') throw new OAuthBindingError('account_disabled');

    const binding = await client.query<{ user_id: string }>(
      `select user_id from oauth_accounts
        where provider = $1 and provider_user_id = $2
          for update`,
      [profile.provider, profile.id],
    );
    const owner = binding.rows[0]?.user_id;
    if (owner && owner !== userId) throw new OAuthBindingError(alreadyLinkedCode(profile.provider));

    if (owner === userId) {
      await client.query(
        `update oauth_accounts
            set provider_email = $3,
                provider_email_verified = true,
                scopes = $4,
                last_used_at = now()
          where provider = $1 and provider_user_id = $2`,
        [profile.provider, profile.id, profile.email, profile.scopes],
      );
    } else {
      await client.query(
        `insert into oauth_accounts
           (user_id, provider, provider_user_id, provider_email, provider_email_verified, scopes, last_used_at)
         values ($1, $2, $3, $4, true, $5, now())`,
        [userId, profile.provider, profile.id, profile.email, profile.scopes],
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

export async function bindOAuthAccount(
  userId: string,
  profile: OAuthProfile,
): Promise<{ alreadyLinked: boolean }> {
  try {
    return await attemptBind(userId, profile);
  } catch (error) {
    if ((error as { code?: string }).code !== '23505') throw error;
    // 并发下别人先绑定了同一个第三方账号：重新读一次归属再决定
    const { rows } = await pool.query<{ user_id: string }>(
      'select user_id from oauth_accounts where provider = $1 and provider_user_id = $2',
      [profile.provider, profile.id],
    );
    if (rows[0]?.user_id === userId) return { alreadyLinked: true };
    throw new OAuthBindingError(alreadyLinkedCode(profile.provider));
  }
}
