/**
 * 自托管嵌入策略：Excalidraw 默认只放行内置白名单站点，其余链接在拖入/粘贴时
 * 会退化成文本。这里改为放行任意合法的 https 地址，同时保留非 https 与非法地址的拦截，
 * 避免把画布变成任意 iframe 注入入口。
 *
 * 说明：放行只代表允许生成 `<iframe>`；目标站点若用 X-Frame-Options / CSP
 * （frame-ancestors）拒绝被内嵌，浏览器仍会显示空白卡片，这属于站点侧限制。
 */

/** 协议必须是 https，且地址中不能出现空白或控制字符（避免解析歧义/换行拼接） */
const HTTPS_URL_RE = /^https:\/\/[^\s]+$/i;
const CONTROL_OR_SPACE_RE = /[\u0000-\u001F\u007F\s]/;

export function isAllowedEmbedUrl(raw: string | null | undefined): boolean {
  if (typeof raw !== "string") return false;
  const value = raw.trim();
  // 空地址、含控制字符/空白的地址直接拒绝
  if (!value || CONTROL_OR_SPACE_RE.test(value) || !HTTPS_URL_RE.test(value)) return false;
  try {
    const url = new URL(value);
    // 再用 URL 解析兜底：确认协议确为 https 且主机名非空
    return url.protocol === "https:" && url.hostname.length > 0;
  } catch {
    return false;
  }
}
