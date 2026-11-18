import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { assessPassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@whiteboard/shared';
import { pool } from '../../infra/db.js';
import { logger } from '../../infra/logger.js';
import { hashPassword, verifyPassword } from '../../auth/password.js';
import { bumpAuthEpoch } from '../../auth/session.js';
import { identityOf, requireUser } from '../../auth/identity.js';
import { parseCookieHeader } from '../../auth/guestCookie.js';
import {
  GITHUB_STATE_COOKIE,
  authorizeUrl as githubAuthorizeUrl,
  buildGithubStateCookie,
  githubConfigured,
  githubRedirectUri,
  saveGithubState,
} from '../../auth/githubOAuth.js';
import {
  GOOGLE_STATE_COOKIE,
  authorizeUrl as googleAuthorizeUrl,
  buildGoogleStateCookie,
  googleConfigured,
  googleRedirectUri,
  saveGoogleState,
} from '../../auth/googleOAuth.js';
import {
  createPkce,
  createState,
  parseStateCookieValue,
  safeReturnTo,
  type OAuthProvider,
  type OAuthStateRecord,
} from '../../auth/oauthShared.js';
import { consumeEmailToken, hashEmailToken } from '../../auth/emailTokens.js';
import { sendEmailVerificationEmail, sendPasswordResetEmail } from '../../auth/emailFlows.js';
import { bindErrorUrl, sameOriginOnly } from './auth.js';
import { AppError } from '../middlewares/error.js';
import {
  clientIp,
  forgotEmailRule,
  forgotIpRule,
  rateLimitConsume,
  rateLimitConsumeAll,
  resetIpRule,
  verifyEmailIpRule,
  verifySendIpRule,
  verifySendUserRule,
} from '../middlewares/rateLimit.js';

/**
 * 账号安全：找回密码、邮箱验证、GitHub / Google 绑定与解绑。
 *
 * 与 `auth.ts` 分开只是为了文件体积；同源校验、会话、限流口径完全复用。
 */

export const accountSecurityRouter = Router();

const handle =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

const emailSchema = z.string().trim().toLowerCase().email().max(254);
const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `密码至少 ${PASSWORD_MIN_LENGTH} 位`)
  .max(PASSWORD_MAX_LENGTH, `密码最多 ${PASSWORD_MAX_LENGTH} 位`);

const forgotSchema = z.object({ email: emailSchema });
const resetSchema = z.object({
  token: z.string().trim().min(16).max(256),
  newPassword: passwordSchema,
});
const tokenSchema = z.object({ token: z.string().trim().min(16).max(256) });

function tooManyAttempts(res: Response, wait: number, message: string): never {
  res.setHeader('Retry-After', String(wait));
  throw new AppError(429, 'TOO_MANY_ATTEMPTS', message);
}

/**
 * 绑定入口是 GET 导航，拿不到 Origin；用 `Sec-Fetch-Site` 拦住「别的站点直接跳过来」的
 * CSRF 式绑定（否则攻击者可让受害者把攻击者的 GitHub 绑到自己账号上）。
 * 旧浏览器没有该头时退化为 Referer 同源校验；直接地址栏访问两者都没有，放行。
 */
function isTrustedBindNavigation(req: Request): boolean {
  const site = req.get('sec-fetch-site');
  if (site) return site === 'same-origin' || site === 'none';

  const referer = req.get('referer');
  if (!referer) return true;
  try {
    const forwarded = req.get('x-forwarded-host')?.split(',')[0]?.trim();
    return new URL(referer).host === (forwarded || req.get('host'));
  } catch {
    return false;
  }
}

/**
 * `POST /api/auth/password/forgot`
 *
 * 防枚举：无论邮箱是否存在、账号是否可用、发信是否成功，都返回同一个成功响应；
 * 只有「存在密码账号」才真正发信。限流按邮箱与 IP 双重计数（含失败尝试）。
 */
accountSecurityRouter.post(
  '/auth/password/forgot',
  sameOriginOnly,
  handle(async (req, res) => {
    const body = forgotSchema.parse(req.body ?? {});
    const wait = await rateLimitConsumeAll([
      forgotEmailRule(body.email),
      forgotIpRule(clientIp(req)),
    ]);
    if (wait !== null) tooManyAttempts(res, wait, '发送太频繁，请稍后再试');

    const { rows } = await pool.query<{
      id: string;
      email: string | null;
      display_name: string;
      status: string;
      has_password: boolean;
    }>(
      `select u.id, u.email, u.display_name, u.status,
              exists(select 1 from credentials c where c.user_id = u.id) as has_password
         from users u
        where u.email = $1`,
      [body.email],
    );
    const user = rows[0];

    if (user && user.status === 'active' && user.email && user.has_password) {
      try {
        await sendPasswordResetEmail(req, {
          id: user.id,
          email: user.email,
          displayName: user.display_name,
        });
      } catch (error) {
        // 发信失败不改变对外结果，避免通过错误差异判断邮箱是否注册
        logger.error({ err: error, userId: user.id }, 'password reset mail failed');
      }
    }

    res.json({ ok: true });
  }),
);

/**
 * `POST /api/auth/password/reset`
 *
 * token 一次性：在同一事务里锁住令牌行，校验「未消费 + 未过期 + 账号可用 + 邮箱未变更」，
 * 再更新密码并把令牌标记为已消费。提交后 `bumpAuthEpoch` 让该用户其它会话全部失效。
 */
accountSecurityRouter.post(
  '/auth/password/reset',
  sameOriginOnly,
  handle(async (req, res) => {
    const wait = await rateLimitConsume(resetIpRule(clientIp(req)));
    if (wait !== null) tooManyAttempts(res, wait, '尝试次数过多，请稍后再试');

    const body = resetSchema.parse(req.body ?? {});
    const assessment = assessPassword(body.newPassword, { email: null });
    if (assessment.blockers.length > 0) {
      throw new AppError(400, 'INVALID_INPUT', assessment.blockers[0] ?? '密码不符合要求');
    }

    const tokenHash = hashEmailToken(body.token);
    const newHash = await hashPassword(body.newPassword);

    const client = await pool.connect();
    let userId: string | null = null;
    try {
      await client.query('begin');
      const { rows } = await client.query<{
        id: string;
        user_id: string;
        email: string;
        consumed_at: Date | null;
        expires_at: Date;
        user_email: string | null;
        status: string;
        password_hash: string | null;
      }>(
        `select t.id, t.user_id, t.email, t.consumed_at, t.expires_at,
                u.email as user_email, u.status, c.password_hash
           from email_tokens t
           join users u on u.id = t.user_id
           left join credentials c on c.user_id = t.user_id
          where t.token_hash = $1 and t.purpose = 'password_reset'
            for update of t`,
        [tokenHash],
      );
      const row = rows[0];

      const usable =
        row &&
        row.consumed_at === null &&
        row.expires_at.getTime() > Date.now() &&
        row.status === 'active' &&
        row.password_hash !== null &&
        row.user_email !== null &&
        row.user_email === row.email;

      if (!usable) throw new AppError(400, 'INVALID_TOKEN', '重置链接无效或已过期，请重新申请');

      if (await verifyPassword(body.newPassword, row.password_hash!)) {
        throw new AppError(400, 'PASSWORD_UNCHANGED', '新密码不能与当前密码相同');
      }

      await client.query(`update email_tokens set consumed_at = now() where id = $1`, [row.id]);
      await client.query(
        `update credentials set password_hash = $2, updated_at = now() where user_id = $1`,
        [row.user_id, newHash],
      );
      await client.query('commit');
      userId = row.user_id;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    if (userId) {
      try {
        await bumpAuthEpoch(userId);
      } catch (error) {
        // 密码已经改成功；epoch 写失败时至少保证不回滚用户可见结果
        logger.error({ err: error, userId }, 'auth epoch bump failed after password reset');
      }
    }

    res.json({ ok: true });
  }),
);

/**
 * `POST /api/auth/email/verification`（登录态）
 *
 * 只维护「邮箱是否验证」这一状态，未验证不影响任何功能；重复调用会作废旧链接。
 */
accountSecurityRouter.post(
  '/auth/email/verification',
  sameOriginOnly,
  requireUser,
  handle(async (req, res) => {
    const identity = identityOf(req);
    const userId = identity.userId;
    if (!userId) throw new AppError(401, 'UNAUTHENTICATED', '请先登录');

    const wait = await rateLimitConsumeAll([
      verifySendUserRule(userId),
      verifySendIpRule(clientIp(req)),
    ]);
    if (wait !== null) tooManyAttempts(res, wait, '发送太频繁，请稍后再试');

    const { rows } = await pool.query<{
      email: string | null;
      display_name: string;
      email_verified_at: Date | null;
      status: string;
    }>(
      `select email, display_name, email_verified_at, status
         from users where id = $1`,
      [userId],
    );
    const user = rows[0];
    if (!user || user.status !== 'active') {
      throw new AppError(401, 'UNAUTHENTICATED', '账号不存在或已停用');
    }
    if (user.email_verified_at) {
      res.json({ ok: true, alreadyVerified: true });
      return;
    }
    if (!user.email) {
      throw new AppError(400, 'NO_EMAIL', '该账号没有邮箱，无法发送验证邮件');
    }

    try {
      await sendEmailVerificationEmail(req, {
        id: userId,
        email: user.email,
        displayName: user.display_name,
      });
    } catch (error) {
      logger.error({ err: error, userId }, 'email verification mail failed');
      throw new AppError(502, 'MAIL_UNAVAILABLE', '验证邮件发送失败，请稍后再试');
    }

    res.json({ ok: true });
  }),
);

/**
 * `POST /api/auth/email/verify`
 *
 * 一次性 token 消费；只写 `users.email_verified_at`，不创建会话、不改变权限。
 */
accountSecurityRouter.post(
  '/auth/email/verify',
  sameOriginOnly,
  handle(async (req, res) => {
    const wait = await rateLimitConsume(verifyEmailIpRule(clientIp(req)));
    if (wait !== null) tooManyAttempts(res, wait, '尝试次数过多，请稍后再试');

    const body = tokenSchema.parse(req.body ?? {});
    const token = await consumeEmailToken(body.token, 'email_verify');
    if (!token) throw new AppError(400, 'INVALID_TOKEN', '验证链接无效或已过期，请重新发送');

    const { rows } = await pool.query<{ email_verified_at: Date | null }>(
      `update users
          set email_verified_at = coalesce(email_verified_at, now())
        where id = $1 and email = $2 and status = 'active'
        returning email_verified_at`,
      [token.userId, token.email],
    );
    if (!rows[0]) throw new AppError(400, 'INVALID_TOKEN', '验证链接无效或已过期，请重新发送');

    res.json({ ok: true, emailVerified: true });
  }),
);

type BindRuntime = {
  provider: OAuthProvider;
  label: string;
  configured: () => boolean;
  cookieName: string;
  buildCookie: (states: string[]) => string;
  saveState: (state: string, record: OAuthStateRecord) => Promise<void>;
  redirectUri: (req: Request) => string;
  authorizeUrl: (input: { state: string; redirectUri: string; challenge: string }) => string;
};

const GITHUB_BIND: BindRuntime = {
  provider: 'github',
  label: 'GitHub',
  configured: githubConfigured,
  cookieName: GITHUB_STATE_COOKIE,
  buildCookie: buildGithubStateCookie,
  saveState: saveGithubState,
  redirectUri: githubRedirectUri,
  authorizeUrl: githubAuthorizeUrl,
};

const GOOGLE_BIND: BindRuntime = {
  provider: 'google',
  label: 'Google',
  configured: googleConfigured,
  cookieName: GOOGLE_STATE_COOKIE,
  buildCookie: buildGoogleStateCookie,
  saveState: saveGoogleState,
  redirectUri: googleRedirectUri,
  authorizeUrl: googleAuthorizeUrl,
};

/**
 * `GET /api/auth/{provider}/bind/start`
 *
 * 复用登录 OAuth 的 state + PKCE，只把模式标记为 bind 并记住发起用户；
 * 回调阶段会校验当前会话与 state 用户一致。
 */
function registerBindStart(runtime: BindRuntime): void {
  accountSecurityRouter.get(
    `/auth/${runtime.provider}/bind/start`,
    requireUser,
    handle(async (req, res) => {
      const identity = identityOf(req);
      const userId = identity.userId;
      const next = safeReturnTo(typeof req.query.next === 'string' ? req.query.next : null) ?? '/boards';

      if (!userId) {
        res.redirect(302, bindErrorUrl(req, runtime.provider, next, 'bind_session_mismatch'));
        return;
      }
      if (!isTrustedBindNavigation(req)) {
        logger.warn({ userId, provider: runtime.provider }, 'oauth bind navigation rejected');
        res.redirect(302, bindErrorUrl(req, runtime.provider, next, 'forbidden'));
        return;
      }
      if (!runtime.configured()) {
        res.redirect(302, bindErrorUrl(req, runtime.provider, next, 'not_configured'));
        return;
      }

      const state = createState('bind');
      const pkce = createPkce();
      const pending = parseStateCookieValue(parseCookieHeader(req.headers.cookie)[runtime.cookieName]);
      try {
        await runtime.saveState(state, {
          returnTo: next,
          codeVerifier: pkce.verifier,
          createdAt: Date.now(),
          mode: 'bind',
          userId,
        });
      } catch (error) {
        logger.error({ err: error }, `${runtime.provider} bind state store unavailable`);
        res.redirect(302, bindErrorUrl(req, runtime.provider, next, 'temporarily_unavailable'));
        return;
      }

      res.append('Set-Cookie', runtime.buildCookie([...pending, state]));
      res.redirect(
        302,
        runtime.authorizeUrl({ state, redirectUri: runtime.redirectUri(req), challenge: pkce.challenge }),
      );
    }),
  );
}

/**
 * 解绑：密码 + 其它 provider 都算「其它登录方式」，只剩当前 provider 时拒绝，
 * 避免用户把自己锁死。GitHub 与 Google 用同一套统计口径。
 */
async function unbindProvider(
  provider: OAuthProvider,
  label: string,
  req: Request,
  res: Response,
): Promise<void> {
  const identity = identityOf(req);
  const userId = identity.userId;
  if (!userId) throw new AppError(401, 'UNAUTHENTICATED', '请先登录');

  const client = await pool.connect();
  let methods: Array<'password' | 'github' | 'google'> = [];
  try {
    await client.query('begin');
    const locked = await client.query<{ status: string }>(
      'select status from users where id = $1 for update',
      [userId],
    );
    if (locked.rows[0]?.status !== 'active') {
      throw new AppError(401, 'UNAUTHENTICATED', '账号不存在或已停用');
    }

    const { rows } = await client.query<{
      has_password: boolean;
      has_current: boolean;
      other_providers: number;
    }>(
      `select exists(select 1 from credentials c where c.user_id = $1) as has_password,
              exists(select 1 from oauth_accounts o
                      where o.user_id = $1 and o.provider = $2) as has_current,
              (select count(*)::int from oauth_accounts o
                where o.user_id = $1 and o.provider <> $2) as other_providers`,
      [userId, provider],
    );
    const row = rows[0];

    if (!row?.has_current) {
      throw new AppError(404, 'NOT_LINKED', `尚未绑定 ${label}`);
    }
    if (!row.has_password && row.other_providers === 0) {
      throw new AppError(
        409,
        'LAST_LOGIN_METHOD',
        '这是当前唯一的登录方式，解绑后将无法登录，因此已拒绝。',
      );
    }

    await client.query('delete from oauth_accounts where user_id = $1 and provider = $2', [userId, provider]);

    const remaining = await client.query<{ provider: OAuthProvider }>(
      'select provider from oauth_accounts where user_id = $1',
      [userId],
    );
    if (row.has_password) methods.push('password');
    for (const item of ['github', 'google'] as const) {
      if (remaining.rows.some((entry) => entry.provider === item)) methods.push(item);
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  res.json({ ok: true, methods });
}

registerBindStart(GITHUB_BIND);
registerBindStart(GOOGLE_BIND);

accountSecurityRouter.delete(
  '/auth/github/binding',
  sameOriginOnly,
  requireUser,
  handle((req, res) => unbindProvider('github', 'GitHub', req, res)),
);

accountSecurityRouter.delete(
  '/auth/google/binding',
  sameOriginOnly,
  requireUser,
  handle((req, res) => unbindProvider('google', 'Google', req, res)),
);
