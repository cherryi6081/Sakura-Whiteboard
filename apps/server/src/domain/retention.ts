/** 回收站保留期与每日清理时间（与设计稿 §06 一致）。 */
export const TRASH_RETENTION_DAYS = 30;
/** 每天 03:00（Asia/Shanghai）清理到期白板 */
export const TRASH_CLEANUP_HOUR = 3;

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 距离下一次 03:00（UTC+8）的毫秒数。
 * 上海没有夏令时，直接按固定 +08:00 折算，不依赖进程时区（容器通常是 UTC）。
 */
export function msUntilNextCleanup(now = new Date()): number {
  const local = now.getTime() + SHANGHAI_OFFSET_MS;
  const startOfLocalDay = Math.floor(local / DAY_MS) * DAY_MS;
  let target = startOfLocalDay + TRASH_CLEANUP_HOUR * 60 * 60 * 1000;
  if (target <= local) target += DAY_MS;
  return target - local;
}
