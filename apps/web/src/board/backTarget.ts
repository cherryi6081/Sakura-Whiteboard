import { sanitizeReturnTo } from "../auth/returnTo";

/**
 * 白板页返回目标（任务：每个白板的返回按钮都应回到进入它时的上一层级页面）。
 *
 * 列表页进入白板时在链接上带 `?from=<当前列表 URL>`，返回按钮优先用它；
 * 没有 `from`（分享链接、直接打开、旧链接）时再看同源 `document.referrer`；
 * 都没有就回 `/boards`。**不用 `history.back()` 当唯一实现**：刷新或直接打开
 * 时历史里没有站内上一页，`back()` 会把用户带走（甚至离开本站）。
 *
 * 只认列表页作为来源（`/boards`、`/boards/trash`），其余一律按无来源处理，
 * 避免 `from` 变成任意跳转。
 */
const LIST_PATH = /^\/boards(?:\/trash)?\/?$/;

/** 是否白板列表类页面（可安全作为「上一级」） */
export function isBoardListPath(href: string): boolean {
  return LIST_PATH.test(href.split(/[?#]/)[0] ?? "");
}

/** 列表链接进板：默认列表 `/boards` 与兜底一致，不写进 URL，保持分享/复制链接干净 */
export function boardHref(boardId: string, from: string): string {
  return from === "/boards" ? `/board/${boardId}` : `/board/${boardId}?from=${encodeURIComponent(from)}`;
}

/** 当前列表页地址（path + query），作为进板时的来源 */
export function currentListHref(): string {
  return `${window.location.pathname}${window.location.search}`;
}

export function resolveBackHref({
  search,
  referrer,
  origin,
}: {
  search: string;
  referrer: string;
  origin: string;
}): string {
  const from = sanitizeReturnTo(new URLSearchParams(search).get("from"));
  if (from && isBoardListPath(from)) return from;

  if (referrer) {
    try {
      const url = new URL(referrer);
      const href = `${url.pathname}${url.search}`;
      if (url.origin === origin && isBoardListPath(href)) return href;
    } catch {
      /* 非法 referrer 当没有来源 */
    }
  }
  return "/boards";
}
