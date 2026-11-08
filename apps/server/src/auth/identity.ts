import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../http/middlewares/error.js';
import { GUEST_COOKIE, maybeRenewGuestCookie, parseCookieHeader, verifyGuestCookieValue } from './guestCookie.js';
import { SESSION_COOKIE, parseSessionCookieValue, readSession } from './session.js';

/**
 * 请求身份：**只从 cookie / Redis 会话推导**，不读取任何客户端自报字段。
 *
 * 优先级（开发文档 §4.5.1）：有会话只认 `userId`；`guestId` 仅作为"待认领凭据"保留，
 * 不参与权限判定。没有会话时才用签名 `wb_gid` 作为游客身份。
 */
export type Identity = {
  userId: string | null;
  sessionId: string | null;
  loginMethod: 'password' | 'oauth:github' | null;
  guestId: string | null;
  guestExp: number | null;
};

declare global {
  namespace Express {
    interface Request {
      identity?: Identity;
    }
  }
}

export const anonymousIdentity = (): Identity => ({
  userId: null,
  sessionId: null,
  loginMethod: null,
  guestId: null,
  guestExp: null,
});

/** 从原始 Cookie 头解析身份；WS 握手也复用这一条。 */
export async function resolveIdentityFromCookieHeader(cookieHeader: string | undefined): Promise<Identity> {
  const jar = parseCookieHeader(cookieHeader);
  const sid = parseSessionCookieValue(jar[SESSION_COOKIE]);
  const session = sid ? await readSession(sid) : null;
  const guest = verifyGuestCookieValue(jar[GUEST_COOKIE]);

  return {
    userId: session?.userId ?? null,
    sessionId: sid,
    loginMethod: session?.loginMethod ?? null,
    guestId: guest?.guestId ?? null,
    guestExp: guest?.exp ?? null,
  };
}

/** 全局中间件：解析身份并挂到 `req.identity`（不签发新 cookie，签发由具体接口决定）。 */
export function attachIdentity(req: Request, res: Response, next: NextFunction): void {
  resolveIdentityFromCookieHeader(req.headers.cookie)
    .then((identity) => {
      req.identity = identity;
      if (identity.guestId && identity.guestExp) {
        maybeRenewGuestCookie(res, { guestId: identity.guestId, exp: identity.guestExp });
      }
      next();
    })
    .catch(next);
}

export function identityOf(req: Request): Identity {
  return req.identity ?? anonymousIdentity();
}

/** 账号接口的硬闸门：无会话一律 401。 */
export function requireUser(req: Request, _res: Response, next: NextFunction): void {
  const identity = identityOf(req);
  if (!identity.userId) {
    next(new AppError(401, 'UNAUTHENTICATED', 'login required'));
    return;
  }
  next();
}
