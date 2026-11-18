/**
 * M3 路由层：**白板身份只从地址栏取**。
 *
 * 明确禁止：把"当前白板"写进 localStorage 再在启动时自动跳转——两个标签会反复抢同一个 ID。
 * 这里只做纯解析，读不读存储由调用方决定（`main.tsx` 不读任何"上次白板"记录）。
 */
import { sanitizeReturnTo } from "../auth/returnTo";

export type BoardRoute =
  | { kind: "board"; boardId: string }
  | { kind: "spike" }
  | { kind: "auth"; mode: "login" | "register"; next: string | null }
  | { kind: "forgot-password" }
  | { kind: "reset-password"; token: string | null }
  | { kind: "verify-email"; token: string | null }
  | { kind: "boards" }
  | { kind: "trash" }
  | { kind: "join"; token: string }
  | { kind: "index" };

/** 与 `LIMITS.boardIdPattern` 保持一致：12 位 `[A-Za-z0-9_-]`。 */
const BOARD_PATH = /^\/board\/([A-Za-z0-9_-]{12})\/?$/;
/** 邀请 token：与服务端 `inviteTokenSchema` 同一区间 */
const JOIN_PATH = /^\/join\/([A-Za-z0-9_-]{16,64})\/?$/;
/** 受限页（必须登录才能使用）：目前只有回收站，页面级守卫见 `auth/RequireLogin.tsx` */
const RESTRICTED_PATH = /^\/boards\/trash\/?$/;

/** 判断某个站内路径是不是受限页（忽略 query / hash） */
export function isRestrictedPath(path: string): boolean {
  return RESTRICTED_PATH.test(path.split(/[?#]/)[0] ?? "");
}

/** 邮件链接里的 token：只接受合理长度的 base64url，异常值按缺失处理。 */
function tokenOf(search: string): string | null {
  const token = new URLSearchParams(search).get("token")?.trim() ?? "";
  return /^[A-Za-z0-9_-]{16,256}$/.test(token) ? token : null;
}

export function parseBoardRoute(pathname: string, search = ""): BoardRoute {
  const match = BOARD_PATH.exec(pathname);
  if (match) return { kind: "board", boardId: match[1] };
  // M5：登录/注册页；`returnTo`（受限页带过来的回跳地址）优先，兼容旧的 `next`。
  // 两者都走同一份白名单：只接受站内相对路径，避免开放重定向。
  const authMatch = /^\/(login|register)\/?$/.exec(pathname);
  if (authMatch) {
    const params = new URLSearchParams(search);
    const next = sanitizeReturnTo(params.get("returnTo")) ?? sanitizeReturnTo(params.get("next"));
    return { kind: "auth", mode: authMatch[1] === "register" ? "register" : "login", next };
  }
  // 账号安全：找回密码 / 重置密码 / 邮箱验证（token 只从 query 取，不做本地存储）
  if (/^\/forgot-password\/?$/.test(pathname)) return { kind: "forgot-password" };
  if (/^\/reset-password\/?$/.test(pathname)) {
    return { kind: "reset-password", token: tokenOf(search) };
  }
  if (/^\/verify-email\/?$/.test(pathname)) {
    return { kind: "verify-email", token: tokenOf(search) };
  }
  // 我的白板列表（登录用户走服务端列表，游客走本机最近打开）
  if (/^\/boards\/?$/.test(pathname)) return { kind: "boards" };
  // 回收站：列表页的第三个状态，独立路由便于刷新/分享；同时是唯一受限页
  if (RESTRICTED_PATH.test(pathname)) return { kind: "trash" };
  // 团队空间邀请链接：与文档里的 shiro.app/join/xxx 一致
  const joinMatch = JOIN_PATH.exec(pathname);
  if (joinMatch) return { kind: "join", token: joinMatch[1] };
  // `/spike` 与历史入口 `/?board=xxx` 都进 M2 前置验证页（boardId 同样来自地址栏）
  if (/^\/spike\/?$/.test(pathname) || new URLSearchParams(search).has("board")) {
    return { kind: "spike" };
  }
  return { kind: "index" };
}
