/** 回收站保留期与每日清理时间（与设计稿 §06 一致）。 */
export const TRASH_RETENTION_DAYS = 30;
/** 每天 03:00（Asia/Shanghai）清理到期白板 */
export const TRASH_CLEANUP_HOUR = 3;

/** 游客板保留期：30 天无编辑 → 软删；软删再 7 天 → 硬删（开发文档 §13.4）。 */
export const GUEST_BOARD_RETENTION_DAYS = 30;
export const GUEST_BOARD_PURGE_DELAY_DAYS = 7;

/** 游客清理与资产 GC 错开 03:00 的回收站清理，避免同一分钟争用连接池。 */
export const GUEST_CLEANUP_HOUR = 3;
export const GUEST_CLEANUP_MINUTE = 10;
export const ASSET_GC_HOUR = 3;
export const ASSET_GC_MINUTE = 20;

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 距离下一次指定时刻（UTC+8）的毫秒数。
 * 上海没有夏令时，直接按固定 +08:00 折算，不依赖进程时区（容器通常是 UTC）。
 */
export function msUntilNextDaily(hour: number, minute = 0, now = new Date()): number {
  const local = now.getTime() + SHANGHAI_OFFSET_MS;
  const startOfLocalDay = Math.floor(local / DAY_MS) * DAY_MS;
  let target = startOfLocalDay + (hour * 60 + minute) * 60 * 1000;
  if (target <= local) target += DAY_MS;
  return target - local;
}

/** 距离下一次 03:00（UTC+8）的毫秒数。 */
export function msUntilNextCleanup(now = new Date()): number {
  return msUntilNextDaily(TRASH_CLEANUP_HOUR, 0, now);
}
