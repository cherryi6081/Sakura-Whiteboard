/**
 * 回收站的时间与文案换算（纯函数，便于单测）。
 *
 * 服务端 `purgeAt = deleted_at + 30 天`，而实际清理发生在每日 03:00（Asia/Shanghai）。
 * 所以一块 14:22 删除的板，真正的删除时刻是第 31 天的 03:00 —— 文案必须按实际时刻算，
 * 否则会出现「剩 0 天但还躺在列表里」的错觉。
 */

export const TRASH_PAGE_SIZE = 12;
export const TRASH_RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const CLEANUP_HOUR = 3;

export type TrashTone = "normal" | "warn" | "danger";

/** 把 purgeAt 上取整到最近一次 03:00（+08:00），得到实际清理时刻。 */
export function effectivePurgeAt(purgeAt: string): number {
  const base = Date.parse(purgeAt);
  if (!Number.isFinite(base)) return Number.NaN;
  const local = base + SHANGHAI_OFFSET_MS;
  const startOfLocalDay = Math.floor(local / DAY_MS) * DAY_MS;
  let target = startOfLocalDay + CLEANUP_HOUR * 60 * 60 * 1000;
  // 恰好 03:00 删除的板会在第 30 天 03:00 被清掉，不需要再顺延一天
  if (target < local) target += DAY_MS;
  return target - SHANGHAI_OFFSET_MS;
}

/**
 * 剩余完整天数（向下取整）：删除当天显示「剩 30 天」，不足 24 小时显示 0 →
 * 列表文案「今天到期」。用 floor 而不是 ceil，避免刚删除就显示「剩 31 天」。
 */
export function remainingTrashDays(purgeAt: string, now = Date.now()): number {
  const target = effectivePurgeAt(purgeAt);
  if (!Number.isFinite(target)) return 0;
  return Math.max(0, Math.floor((target - now) / DAY_MS));
}

export function trashTone(days: number): TrashTone {
  if (days <= 0) return "danger";
  if (days <= 7) return "warn";
  return "normal";
}

export function trashPill(purgeAt: string, now = Date.now()): { label: string; tone: TrashTone } {
  const days = remainingTrashDays(purgeAt, now);
  return { label: days <= 0 ? "今天到期" : `剩 ${days} 天`, tone: trashTone(days) };
}

const pad = (value: number) => String(value).padStart(2, "0");

/** 列表时间列：`11-10 14:22`（浏览器本地时区）。 */
export function formatDeletedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 保留期 tooltip：`将于 2026-12-10 03:00 自动删除` */
export function formatPurgeTitle(purgeAt: string): string {
  const target = effectivePurgeAt(purgeAt);
  if (!Number.isFinite(target)) return "30 天后自动删除";
  const date = new Date(target);
  return `将于 ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} 03:00 自动删除`;
}

export function isExpiringSoon(purgeAt: string, now = Date.now()): boolean {
  return remainingTrashDays(purgeAt, now) <= 7;
}
