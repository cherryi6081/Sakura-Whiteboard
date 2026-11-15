/**
 * 跨标签页的登录态广播。
 *
 * 退出登录只发生在首页导航的账号菜单里，但其它标签页可能正停在 `/boards`、
 * `/boards/trash`，它们手里的列表、容量计数、空间胶囊还是上一个账号的。
 * 这里用 BroadcastChannel 发一条「已退出」，让这些页面立刻切成游客视图，
 * 而不是等下一次请求 401 或刷新才纠正。
 *
 * 同标签页不会收到自己的广播（BroadcastChannel 约定），调用方在发消息后自行更新 UI。
 */

export const AUTH_CHANNEL_NAME = "wb-auth";

export type AuthEvent = { type: "logout" };

function channel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  try {
    return new BroadcastChannel(AUTH_CHANNEL_NAME);
  } catch {
    return null;
  }
}

/** 广播「已退出登录」；不支持的浏览器静默跳过（各页仍有 401 兜底）。 */
export function publishLogout(): void {
  const ch = channel();
  if (!ch) return;
  try {
    ch.postMessage({ type: "logout" } satisfies AuthEvent);
  } finally {
    ch.close();
  }
}

/** 订阅退出登录；返回取消订阅函数。 */
export function subscribeLogout(handler: () => void): () => void {
  const ch = channel();
  if (!ch) return () => undefined;
  ch.onmessage = (event: MessageEvent<AuthEvent>) => {
    if (event.data?.type === "logout") handler();
  };
  return () => {
    ch.onmessage = null;
    ch.close();
  };
}
