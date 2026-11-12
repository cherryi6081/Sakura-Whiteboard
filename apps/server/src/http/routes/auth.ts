import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { assessPassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@whiteboard/shared';
import { pool } from '../../infra/db.js';
import { hashPassword, verifyPassword } from '../../auth/password.js';
import { clearSessionCookie, createSession, destroySession } from '../../auth/session.js';
import { identityOf, requireUser } from '../../auth/identity.js';
import { AppError } from '../middlewares/error.js';

/**
 * 邮箱 + 密码账号（M5-1）。GitHub OAuth 明确**不做**，`GITHUB_*` 环境变量保持预留。
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

const handle =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

/**
 * 浏览器跨站 POST 防护：有 Origin 时必须与 Host 同源；非浏览器客户端（无 Origin）放行。
 */
function sameOriginOnly(req: Request, _res: Response, next: NextFunction): void {
  const origin = req.get('origin');
  if (!origin) {
    next();
    return;
  }
  try {
    const parsed = new URL(origin);
    if (parsed.host !== req.get('host')) {
      next(new AppError(403, 'FORBIDDEN', 'cross-origin request rejected'));
      return;
    }
  } catch {
    next(new AppError(403, 'FORBIDDEN', 'invalid origin'));
    return;
  }
  next();
}

type UserRow = {
  id: string;
  email: string | null;
  display_name: string;
  color: string;
};

type UserWithCredentialRow = UserRow & { password_hash: string; status: string };

const toUser = (row: UserRow) => ({
  id: row.id,
  email: row.email,
  displayName: row.display_name,
  color: row.color,
});

authRouter.post(
  '/auth/register',
  sameOriginOnly,
  handle(async (req, res) => {
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
         returning id, email, display_name, color`,
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
    res.status(201).json({ user: toUser(row), methods: ['password'], loginMethod });
  }),
);

authRouter.post(
  '/auth/login',
  sameOriginOnly,
  handle(async (req, res) => {
    const body = loginSchema.parse(req.body);
    const { rows } = await pool.query<UserWithCredentialRow>(
      `select u.id, u.email, u.display_name, u.color, u.status, c.password_hash
         from users u
         join credentials c on c.user_id = u.id
        where u.email = $1`,
      [body.email],
    );

    const row = rows[0];
    // 邮箱不存在与密码错误统一 401，不区分原因
    if (!row || row.status !== 'active' || !(await verifyPassword(row.password_hash, body.password))) {
      throw new AppError(401, 'INVALID_CREDENTIALS', '邮箱或密码错误');
    }

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

authRouter.get(
  '/auth/me',
  requireUser,
  handle(async (req, res) => {
    const identity = identityOf(req);
    const userId = identity.userId;
    if (!userId) throw new AppError(401, 'UNAUTHENTICATED', 'login required');

    const { rows } = await pool.query<UserRow & { has_password: boolean; has_github: boolean }>(
      `select u.id, u.email, u.display_name, u.color,
              exists(select 1 from credentials c where c.user_id = u.id) as has_password,
              exists(select 1 from oauth_accounts o where o.user_id = u.id and o.provider = 'github') as has_github
         from users u
        where u.id = $1`,
      [userId],
    );
    const row = rows[0];
    if (!row) throw new AppError(401, 'UNAUTHENTICATED', 'session user missing');

    const methods: Array<'password' | 'github'> = [];
    if (row.has_password) methods.push('password');
    if (row.has_github) methods.push('github');

    res.json({
      user: toUser(row),
      methods,
      loginMethod: identity.loginMethod,
    });
  }),
);
