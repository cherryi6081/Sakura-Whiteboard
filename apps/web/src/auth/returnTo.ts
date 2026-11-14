/**
 * 受限页回跳地址（`returnTo`）的白名单。
 *
 * 只接受**站内相对路径**：
 * - 必须以单个 `/` 开头；`//host`、`/\host`、`https://evil.example` 一律拒绝（防开放重定向）；
 * - 解析后的 origin 必须仍是占位 origin，防编码绕过；
 * - 登录 / 注册页自身不作为回跳目标，避免「登录成功又被要求登录」的死循环。
 *
 * 用固定的占位 origin 做解析，不依赖 `window`，便于单测。
 */
const PLACEHOLDER_ORIGIN = "http://return-to.invalid";
const AUTH_PATH = /^\/(login|register)\/?$/;

export function sanitizeReturnTo(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return null;

  let url: URL;
  try {
    url = new URL(raw, PLACEHOLDER_ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== PLACEHOLDER_ORIGIN) return null;
  if (AUTH_PATH.test(url.pathname)) return null;

  const target = `${url.pathname}${url.search}${url.hash}`;
  // 解析后再确认一次：结果必须还是站内单斜杠路径
  if (!target.startsWith("/") || target.startsWith("//")) return null;
  return target;
}
