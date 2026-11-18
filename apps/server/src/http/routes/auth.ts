import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { assessPassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@whiteboard/shared';
import { pool } from '../../infra/db.js';
import { logger } from '../../infra/logger.js';
import { hashPassword, verifyPassword } from '../../auth/password.js';
import { clearSessionCookie, createSession, destroySession, bumpAuthEpoch } from '../../auth/session.js';
import { identityOf, requireUser } from '../../auth/identity.js';
import { parseCookieHeader } from '../../auth/guestCookie.js';
import {
  GITHUB_SCOPE,
  GITHUB_STATE_COOKIE,
  authorizeUrl as githubAuthorizeUrl,
  buildGithubStateCookie,
  clearGithubStateCookie,
  consumeGithubState,
  exchangeCode as githubExchangeCode,
  fetchGithubProfile,
  githubConfigured,
  githubRedirectUri,
  loginErrorUrl as githubLoginErrorUrl,
  saveGithubState,
} from '../../auth/githubOAuth.js';
import {
  GOOGLE_SCOPE,
  GOOGLE_STATE_COOKIE,
  authorizeUrl as googleAuthorizeUrl,
  buildGoogleStateCookie,
  clearGoogleStateCookie,
  consumeGoogleState,
  exchangeCode as googleExchangeCode,
  fetchGoogleProfile,
  googleConfigured,
  googleRedirectUri,
  loginErrorUrl as googleLoginErrorUrl,
  saveGoogleState,
} from '../../auth/googleOAuth.js';
import {
  createPkce,
  createState,
  isBindState,
  parseStateCookieValue,
  safeReturnTo,
  webAppUrl,
  OAuthError,
  type OAuthProvider,
  type OAuthStateRecord,
} from '../../auth/oauthShared.js';
import { loginWithOAuth, bindOAuthAccount, OAuthBindingError, type OAuthProfile } from '../../domain/oauthAccount.js';
import { purgeAccount } from '../../domain/accountDeletion.js';
import { sendEmailVerificationEmail } from '../../auth/emailFlows.js';
import { AppError } from '../middlewares/error.js';
import {
  clientIp,
  loginEmailRule,
  loginIpRule,
  rateLimitClear,
  rateLimitConsume,
  rateLimitRecord,
  rateLimitWait,
  registerIpRule,
} from '../middlewares/rateLimit.js';

/**
 * 邮箱 + 密码账号（M5-1）+ GitHub / Google OAuth。
 * 会话存 Redis（`sess:{sid}`），cookie `wb_sess` 为 HttpOnly 签名值。
 */

export const authRouter = Router();

const emailSchema = z.string().trim().toLowerCase().email().max(254);
const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `密码至少 ${PASSWORD_MIN_LENGTH} 位`)
  .max(PASSWORD_MAX_LENGTH, `密码最多 ${PASSWORD_MAX_LENGTH} 位`);

const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(2).max(24).optional(),
});

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(72),
});

/** 资料修改只开放现有列，`display_name` 的 2–24 长度与建表约束一致。 */
const profileSchema = z.object({
  displayName: z.string().trim().min(2).max(24),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(72),
  newPassword: passwordSchema,
});

const closeAccountSchema = z.object({
  currentPassword: z.string().min(1).max(72),
});

/** 绑定流程结束统一回站点页并打开账号设置（`account=1`），由前端展示结果。 */
const ACCOUNT_RETURN = '/boards';

function accountReturnUrl(
  req: Request,
  next: string | null,
  params: Record<string, string>,
): string {
  const url = new URL(webAppUrl(req, safeReturnTo(next) ?? ACCOUNT_RETURN));
  url.searchParams.set('account', '1');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

export function bindErrorUrl(
  req: Request,
  provider: OAuthProvider,
  next: string | null,
  code: string,
): string {
  return accountReturnUrl(req, next, { [`${provider}Error`]: code });
}

export function bindSuccessUrl(
  req: Request,
  provider: OAuthProvider,
  next: string | null,
  alreadyLinked: boolean,
): string {
  return accountReturnUrl(req, next, { [provider]: alreadyLinked ? 'already-linked' : 'linked' });
}

const handle =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

/**
 * 浏览器跨站 POST 防护：有 Origin 时必须与 Host 同源；非浏览器客户端（无 Origin）放行。
 * 反向代理（如 Vite dev server 改写了 Host）会优先参考 `x-forwarded-host`。
 */
/** 头像上传路由复用同一份来源校验，避免两套 CSRF 口径。 */
export function sameOriginOnly(req: Request, _res: Response, next: NextFunction): void {
  const origin = req.get('origin');
  if (!origin) {
    next();
    return;
  }
  try {
    const parsed = new URL(origin);
    const forwarded = req.get('x-forwarded-host')?.split(',')[0]?.trim();
    const host = forwarded || req.get('host');
    if (parsed.host !== host) {
      logger.warn({ origin, host, forwardedHost: forwarded ?? null }, 'cross-origin request rejected');
      next(new AppError(403, 'FORBIDDEN', 'cross-origin request rejected'));
      return;
    }
  } catch {
    next(new AppError(403, 'FORBIDDEN', 'invalid origin'));
    return;
  }
  next();
}

export type UserRow = {
  id: string;
  email: string | null;
  display_name: string;
  color: string;
  avatar_url: string | null;
  email_verified_at?: string | null;
};

type UserWithCredentialRow = UserRow & { password_hash: string; status: string };

export const toUser = (row: UserRow) => ({
  id: row.id,
  email: row.email,
  displayName: row.display_name,
  color: row.color,
  avatarUrl: row.avatar_url,
  /** 仅表示状态；未验证不影响任何现有功能。 */
  emailVerified: Boolean(row.email_verified_at),
});

authRouter.post(
  '/auth/register',
  sameOriginOnly,
  handle(async (req, res) => {
    // 注册按 IP 计数（含失败尝试），每小时上限，挡住批量注册
    const wait = await rateLimitConsume(registerIpRule(clientIp(req)));
    if (wait !== null) {
      res.setHeader('Retry-After', String(wait));
      throw new AppError(429, 'TOO_MANY_ATTEMPTS', '注册尝试过多，请稍后再试');
    }

    const body = registerSchema.parse(req.body);
    const displayName = body.displayName ?? body.email.split('@')[0]?.slice(0, 24) ?? '用户';
    // 长度以外的硬门槛（弱口令表、邮箱前缀）与前端共用同一份规则
    const assessment = assessPassword(body.password, { email: body.email });
    if (assessment.blockers.length > 0) {
      throw new AppError(400, 'INVALID_INPUT', assessment.blockers[0] ?? '密码不符合要求');
    }
    const passwordHash = await hashPassword(body.password);

    const client = await pool.connect();
    let row: UserRow | null = null;
    try {
      await client.query('begin');
      const inserted = await client.query<UserRow>(
        `insert into users (email, display_name)
         values ($1, $2)
         returning id, email, display_name, color, avatar_url, email_verified_at`,
        [body.email, displayName],
      );
      row = inserted.rows[0] ?? null;
      if (!row) throw new Error('user insert returned no row');
      await client.query('insert into credentials (user_id, password_hash) values ($1, $2)', [row.id, passwordHash]);
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      const code = (err as { code?: string }).code;
      if (code === '23505') throw new AppError(409, 'EMAIL_TAKEN', '该邮箱已注册，可直接登录');
      if (code === '23514') throw new AppError(400, 'INVALID_INPUT', '昵称或邮箱不符合要求');
      throw err;
    } finally {
      client.release();
    }

    const userId = row.id;
    const loginMethod = 'password' as const;
    await createSession(userId, loginMethod, res);
    // 注册后自动发一封验证邮件；失败只告警，不影响注册与会话
    if (row.email) {
      void sendEmailVerificationEmail(req, {
        id: row.id,
        email: row.email,
        displayName: row.display_name,
      }).catch((err) => logger.warn({ err, userId: row.id }, 'register verification mail failed'));
    }
    res.status(201).json({ user: toUser(row), methods: ['password'], loginMethod });
  }),
);

authRouter.post(
  '/auth/login',
  sameOriginOnly,
  handle(async (req, res) => {
    const body = loginSchema.parse(req.body);

    // 先看额度：按账号 5 次失败 / 按 IP 20 次失败，两者都要过（15 分钟窗口）
    const emailRule = loginEmailRule(body.email);
    const ipRule = loginIpRule(clientIp(req));
    const wait = await rateLimitWait([emailRule, ipRule]);
    if (wait !== null) {
      res.setHeader('Retry-After', String(wait));
      throw new AppError(429, 'TOO_MANY_ATTEMPTS', '尝试次数过多，请稍后再试');
    }

    const { rows } = await pool.query<UserWithCredentialRow>(
      `select u.id, u.email, u.display_name, u.color, u.avatar_url, u.email_verified_at,
              u.status, c.password_hash
         from users u
         join credentials c on c.user_id = u.id
        where u.email = $1`,
      [body.email],
    );

    const row = rows[0];
    // 邮箱不存在与密码错误统一 401，不区分原因
    if (!row || row.status !== 'active' || !(await verifyPassword(row.password_hash, body.password))) {
      await rateLimitRecord([emailRule, ipRule]);
      throw new AppError(401, 'INVALID_CREDENTIALS', '邮箱或密码错误');
    }

    // 成功登录清掉账号维度的失败计数；IP 计数保留
    await rateLimitClear([emailRule.key]);

    await pool.query('update users set last_login_at = now() where id = $1', [row.id]);
    await pool.query('update credentials set last_used_at = now() where user_id = $1', [row.id]);

    const loginMethod = 'password' as const;
    await createSession(row.id, loginMethod, res);
    res.json({ user: toUser(row), methods: ['password'], loginMethod });
  }),
);

authRouter.post(
  '/auth/logout',
  sameOriginOnly,
  handle(async (req, res) => {
    const identity = identityOf(req);
    if (identity.sessionId) await destroySession(identity.sessionId);
    res.append('Set-Cookie', clearSessionCookie());
    res.status(204).end();
  }),
);

authRouter.get('/auth/providers', (_req, res) => {
  res.json({ github: githubConfigured(), google: googleConfigured() });
});

/**
 * 每家 provider 的差异收敛到这张表：cookie 名、端点、scope、资料解析与会话里的登录方式。
 * 登录起点 / 回调只写一份，Google 与 GitHub 走完全相同的 state、PKCE、合并与错误口径。
 */
type OAuthRuntime = {
  provider: OAuthProvider;
  loginMethod: 'oauth:github' | 'oauth:google';
  configured: () => boolean;
  loginErrorUrl: (req: Request, code: string, next: string | null) => string;
  cookieName: string;
  buildCookie: (states: string[]) => string;
  clearCookie: () => string;
  saveState: (state: string, record: OAuthStateRecord) => Promise<void>;
  consumeState: (state: string) => Promise<OAuthStateRecord | null>;
  redirectUri: (req: Request) => string;
  authorizeUrl: (input: { state: string; redirectUri: string; challenge: string }) => string;
  loadProfile: (input: { code: string; redirectUri: string; verifier: string }) => Promise<OAuthProfile>;
};

const GITHUB_RUNTIME: OAuthRuntime = {
  provider: 'github',
  loginMethod: 'oauth:github',
  configured: githubConfigured,
  loginErrorUrl: githubLoginErrorUrl,
  cookieName: GITHUB_STATE_COOKIE,
  buildCookie: buildGithubStateCookie,
  clearCookie: clearGithubStateCookie,
  saveState: saveGithubState,
  consumeState: consumeGithubState,
  redirectUri: githubRedirectUri,
  authorizeUrl: githubAuthorizeUrl,
  loadProfile: async (input) => {
    const token = await githubExchangeCode(input);
    const profile = await fetchGithubProfile(token);
    return { provider: 'github', ...profile, scopes: GITHUB_SCOPE };
  },
};

const GOOGLE_RUNTIME: OAuthRuntime = {
  provider: 'google',
  loginMethod: 'oauth:google',
  configured: googleConfigured,
  loginErrorUrl: googleLoginErrorUrl,
  cookieName: GOOGLE_STATE_COOKIE,
  buildCookie: buildGoogleStateCookie,
  clearCookie: clearGoogleStateCookie,
  saveState: saveGoogleState,
  consumeState: consumeGoogleState,
  redirectUri: googleRedirectUri,
  authorizeUrl: googleAuthorizeUrl,
  loadProfile: async (input) => {
    const token = await googleExchangeCode(input);
    const profile = await fetchGoogleProfile(token);
    return { provider: 'google', ...profile, scopes: GOOGLE_SCOPE };
  },
};

/**
 * 登录起点：生成一次性 state + PKCE，把 state 落到 Redis 与 HttpOnly cookie，然后 302 到第三方。
 * 未配置时同样 302 回登录页并带 `oauthError=not_configured&oauth=<provider>`，
 * 前端据此不展示入口，也避免直接访问时白屏。
 */
function registerLoginStart(runtime: OAuthRuntime): void {
  authRouter.get(
    `/auth/${runtime.provider}/start`,
    handle(async (req, res) => {
      const next = safeReturnTo(typeof req.query.next === 'string' ? req.query.next : null) ?? '/';
      if (!runtime.configured()) {
        res.redirect(302, runtime.loginErrorUrl(req, 'not_configured', next));
        return;
      }
      const state = createState();
      const pkce = createPkce();
      // 连点两次会开两条授权流程：cookie 里保留多个候选 state，先回来的那条也能通过校验
      const pending = parseStateCookieValue(parseCookieHeader(req.headers.cookie)[runtime.cookieName]);
      try {
        await runtime.saveState(state, { returnTo: next, codeVerifier: pkce.verifier, createdAt: Date.now() });
      } catch (error) {
        logger.error({ err: error }, `${runtime.provider} oauth state store unavailable`);
        res.redirect(302, runtime.loginErrorUrl(req, 'temporarily_unavailable', next));
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
 * 回调：state 必须同时命中 cookie 与 Redis（消费即删，防重放），
 * 之后换 token、取已验证邮箱、合并或新建账号，最后种会话并回站内落点。
 * 所有失败都回登录页带可读错误码，不静默登录。
 */
function registerLoginCallback(runtime: OAuthRuntime): void {
  authRouter.get(
    `/auth/${runtime.provider}/callback`,
    handle(async (req, res) => {
      const { provider } = runtime;
      const state = typeof req.query.state === 'string' ? req.query.state : '';
      const cookies = parseCookieHeader(req.headers.cookie);
      const candidates = parseStateCookieValue(cookies[runtime.cookieName]);
      // 只摘掉本次消费的 state，其它并发流程（连点两次）仍然有效
      const remaining = candidates.filter((item) => item !== state);
      res.append('Set-Cookie', remaining.length > 0 ? runtime.buildCookie(remaining) : runtime.clearCookie());

      // state 带 `b~` 前缀即为绑定流程：即使 Redis 里的记录已过期，也把用户送回账号设置
      const bindAttempt = isBindState(state);

      if (!runtime.configured()) {
        res.redirect(
          302,
          bindAttempt
            ? bindErrorUrl(req, provider, null, 'not_configured')
            : runtime.loginErrorUrl(req, 'not_configured', null),
        );
        return;
      }
      if (!state || !candidates.includes(state)) {
        res.redirect(
          302,
          bindAttempt
            ? bindErrorUrl(req, provider, null, 'state_mismatch')
            : runtime.loginErrorUrl(req, 'state_mismatch', null),
        );
        return;
      }

      let record: OAuthStateRecord | null = null;
      let storeFailed = false;
      try {
        record = await runtime.consumeState(state);
      } catch (error) {
        storeFailed = true;
        logger.warn({ err: error }, `${provider} oauth state store unavailable`);
      }
      if (!record) {
        // cookie 命中但 Redis 里没有：TTL 到期、已被消费（重复回调）或存储不可用
        const failure = storeFailed ? 'temporarily_unavailable' : 'state_expired';
        res.redirect(
          302,
          bindAttempt
            ? bindErrorUrl(req, provider, null, failure)
            : runtime.loginErrorUrl(req, failure, null),
        );
        return;
      }

      const isBind = record.mode === 'bind';
      if (isBind) {
        // 绑定必须在发起流程的同一登录会话里完成，避免 A 账号发起、B 账号回调时串绑
        const identity = identityOf(req);
        if (!record.userId || identity.userId !== record.userId) {
          res.redirect(302, bindErrorUrl(req, provider, record.returnTo, 'bind_session_mismatch'));
          return;
        }
      }

      const providerError = typeof req.query.error === 'string' ? req.query.error : '';
      if (providerError) {
        const code = providerError === 'access_denied' ? 'access_denied' : `${provider}_error`;
        res.redirect(
          302,
          isBind
            ? bindErrorUrl(req, provider, record.returnTo, code)
            : runtime.loginErrorUrl(req, code, record.returnTo),
        );
        return;
      }

      const code = typeof req.query.code === 'string' ? req.query.code : '';
      if (!code) {
        res.redirect(
          302,
          isBind
            ? bindErrorUrl(req, provider, record.returnTo, `${provider}_error`)
            : runtime.loginErrorUrl(req, `${provider}_error`, record.returnTo),
        );
        return;
      }

      try {
        const profile = await runtime.loadProfile({
          code,
          redirectUri: runtime.redirectUri(req),
          verifier: record.codeVerifier,
        });

        if (isBind) {
          const userId = record.userId!;
          const { alreadyLinked } = await bindOAuthAccount(userId, profile);
          res.redirect(302, bindSuccessUrl(req, provider, record.returnTo, alreadyLinked));
          return;
        }

        const { userId } = await loginWithOAuth(profile);
        await createSession(userId, runtime.loginMethod, res);
        // 回调落在 API 端口，最终跳转要指回前端来源（开发 5173 / 生产同源）
        res.redirect(302, webAppUrl(req, safeReturnTo(record.returnTo) ?? '/'));
      } catch (error) {
        if (error instanceof OAuthBindingError) {
          logger.warn({ err: error, code: error.code }, `${provider} bind rejected`);
          res.redirect(302, bindErrorUrl(req, provider, record.returnTo, error.code));
          return;
        }
        if (error instanceof OAuthError) {
          logger.warn({ err: error, code: error.code }, `${provider} oauth rejected`);
          res.redirect(
            302,
            isBind
              ? bindErrorUrl(req, provider, record.returnTo, error.code)
              : runtime.loginErrorUrl(req, error.code, record.returnTo),
          );
          return;
        }
        logger.error({ err: error }, `${provider} oauth failed`);
        res.redirect(
          302,
          isBind
            ? bindErrorUrl(req, provider, record.returnTo, 'temporarily_unavailable')
            : runtime.loginErrorUrl(req, 'temporarily_unavailable', record.returnTo),
        );
      }
    }),
  );
}

registerLoginStart(GITHUB_RUNTIME);
registerLoginCallback(GITHUB_RUNTIME);
registerLoginStart(GOOGLE_RUNTIME);
registerLoginCallback(GOOGLE_RUNTIME);

authRouter.get(
  '/auth/me',
  requireUser,
  handle(async (req, res) => {
    const identity = identityOf(req);
    const userId = identity.userId;
    if (!userId) throw new AppError(401, 'UNAUTHENTICATED', 'login required');

    const { rows } = await pool.query<UserRow & { has_password: boolean; has_github: boolean; has_google: boolean }>(
      `select u.id, u.email, u.display_name, u.color, u.avatar_url, u.email_verified_at,
              exists(select 1 from credentials c where c.user_id = u.id) as has_password,
              exists(select 1 from oauth_accounts o where o.user_id = u.id and o.provider = 'github') as has_github,
              exists(select 1 from oauth_accounts o where o.user_id = u.id and o.provider = 'google') as has_google
         from users u
        where u.id = $1`,
      [userId],
    );
    const row = rows[0];
    if (!row) throw new AppError(401, 'UNAUTHENTICATED', 'session user missing');

    const methods: Array<'password' | 'github' | 'google'> = [];
    if (row.has_password) methods.push('password');
    if (row.has_github) methods.push('github');
    if (row.has_google) methods.push('google');

    res.json({
      user: toUser(row),
      methods,
      loginMethod: identity.loginMethod,
    });
  }),
);

/**
 * `PATCH /api/auth/me` —— 修改显示名。
 *
 * 只改 `users.display_name`：空间名、白板标题、历史 op 归属都是各自独立的业务数据，
 * 不随昵称联动。返回体与 `GET /auth/me` 的 `user` 保持一致，前端直接就地替换。
 */
authRouter.patch(
  '/auth/me',
  sameOriginOnly,
  requireUser,
  handle(async (req, res) => {
    const identity = identityOf(req);
    const userId = identity.userId;
    if (!userId) throw new AppError(401, 'UNAUTHENTICATED', 'login required');

    const { displayName } = profileSchema.parse(req.body ?? {});
    const { rows } = await pool.query<UserRow>(
      `update users set display_name = $2
        where id = $1 and status = 'active'
        returning id, email, display_name, color, avatar_url, email_verified_at`,
      [userId, displayName],
    );
    const row = rows[0];
    if (!row) throw new AppError(401, 'UNAUTHENTICATED', 'session user missing');

    res.json({ user: toUser(row) });
  }),
);

/**
 * `POST /api/auth/password` —— 登录态改密（本轮不做找回密码 / 邮箱验证）。
 *
 * 成功后的处理顺序：
 * 1. 写入新的 argon2id 哈希；
 * 2. `bumpAuthEpoch` 把该账号所有旧会话作废（其它标签/设备下次请求即 401）；
 * 3. 销毁当前 sid 并重签一条新会话，当前页面无感继续在线。
 */
authRouter.post(
  '/auth/password',
  sameOriginOnly,
  requireUser,
  handle(async (req, res) => {
    const identity = identityOf(req);
    const userId = identity.userId;
    if (!userId) throw new AppError(401, 'UNAUTHENTICATED', 'login required');

    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body ?? {});

    const { rows } = await pool.query<{ password_hash: string; email: string | null }>(
      `select c.password_hash, u.email
         from credentials c
         join users u on u.id = c.user_id
        where c.user_id = $1`,
      [userId],
    );
    const row = rows[0];
    if (!row) throw new AppError(400, 'NO_PASSWORD', '该账号尚未设置密码');

    // 旧密码错误与账号不存在统一 401，不区分原因
    if (!(await verifyPassword(row.password_hash, currentPassword))) {
      throw new AppError(401, 'INVALID_CREDENTIALS', '当前密码不正确');
    }
    // 新密码与旧密码相同：直接拒绝，避免"改了个寂寞"却把其它会话踢下线
    if (await verifyPassword(row.password_hash, newPassword)) {
      throw new AppError(400, 'PASSWORD_UNCHANGED', '新密码不能与当前密码相同');
    }
    const assessment = assessPassword(newPassword, { email: row.email });
    if (assessment.blockers.length > 0) {
      throw new AppError(400, 'INVALID_INPUT', assessment.blockers[0] ?? '密码不符合要求');
    }

    const passwordHash = await hashPassword(newPassword);
    await pool.query('update credentials set password_hash = $2, updated_at = now() where user_id = $1', [
      userId,
      passwordHash,
    ]);

    await bumpAuthEpoch(userId);
    if (identity.sessionId) await destroySession(identity.sessionId);
    await createSession(userId, 'password', res);

    res.json({ ok: true });
  }),
);

/**
 * `DELETE /api/auth/me` —— 销号（不可恢复，需当前密码确认）。
 *
 * 数据口径见 `domain/accountDeletion.ts`：用户行保留为 disabled，业务数据物理删除。
 * 成功后就地作废所有会话并清 cookie；前端收到 200 走本地登出广播回首页。
 */
authRouter.delete(
  '/auth/me',
  sameOriginOnly,
  requireUser,
  handle(async (req, res) => {
    const identity = identityOf(req);
    const userId = identity.userId;
    if (!userId) throw new AppError(401, 'UNAUTHENTICATED', 'login required');

    const { currentPassword } = closeAccountSchema.parse(req.body ?? {});
    const { rows } = await pool.query<{ password_hash: string }>(
      'select password_hash from credentials where user_id = $1',
      [userId],
    );
    const row = rows[0];
    if (!row || !(await verifyPassword(row.password_hash, currentPassword))) {
      throw new AppError(401, 'INVALID_CREDENTIALS', '密码不正确');
    }

    await purgeAccount(userId);
    await bumpAuthEpoch(userId);
    if (identity.sessionId) await destroySession(identity.sessionId);
    res.append('Set-Cookie', clearSessionCookie());

    res.json({ ok: true });
  }),
);
