/**
 * M3 路由层：**白板身份只从地址栏取**。
 *
 * 明确禁止：把"当前白板"写进 localStorage 再在启动时自动跳转——两个标签会反复抢同一个 ID。
 * 这里只做纯解析，读不读存储由调用方决定（`main.tsx` 不读任何"上次白板"记录）。
 */
export type BoardRoute =
  | { kind: "board"; boardId: string }
  | { kind: "spike" }
  | { kind: "auth"; mode: "login" | "register"; next: string | null }
  | { kind: "boards" }
  | { kind: "trash" }
  | { kind: "index" };

/** 与 `LIMITS.boardIdPattern` 保持一致：12 位 `[A-Za-z0-9_-]`。 */
const BOARD_PATH = /^\/board\/([A-Za-z0-9_-]{12})\/?$/;

export function parseBoardRoute(pathname: string, search = ""): BoardRoute {
  const match = BOARD_PATH.exec(pathname);
  if (match) return { kind: "board", boardId: match[1] };
  // M5：登录/注册页；`next` 只接受站内绝对路径，避免开放重定向
  const authMatch = /^\/(login|register)\/?$/.exec(pathname);
  if (authMatch) {
    const raw = new URLSearchParams(search).get("next");
    const next = raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : null;
    return { kind: "auth", mode: authMatch[1] === "register" ? "register" : "login", next };
  }
  // 我的白板列表（登录用户走服务端列表，游客走本机最近打开）
  if (/^\/boards\/?$/.test(pathname)) return { kind: "boards" };
  // 回收站：列表页的第三个状态，独立路由便于刷新/分享
  if (/^\/boards\/trash\/?$/.test(pathname)) return { kind: "trash" };
  // `/spike` 与历史入口 `/?board=xxx` 都进 M2 前置验证页（boardId 同样来自地址栏）
  if (/^\/spike\/?$/.test(pathname) || new URLSearchParams(search).has("board")) {
    return { kind: "spike" };
  }
  return { kind: "index" };
}
