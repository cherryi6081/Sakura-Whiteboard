/**
 * 恢复同名白板时的自动改名（回收站设计稿 §05）。
 *
 * 规则：目标空间内已有同名（忽略首尾空格与大小写）时，追加「（2）」「（3）」递增。
 * 数据库 `boards.title` 限制 1–80 字符，所以拼后缀前要先按后缀宽度截断原名，
 * 不能先截 80 再拼，否则更新会撞 check 约束。
 */

/** 与 0001_init.sql 的 `char_length(title) between 1 and 80` 保持一致 */
export const BOARD_TITLE_MAX = 80;

export function uniqueBoardTitle(desired: string, taken: readonly string[]): string {
  const base = desired.trim().slice(0, BOARD_TITLE_MAX) || '未命名白板';
  const used = new Set(taken.map((title) => title.trim().toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;

  for (let n = 2; n <= 999; n += 1) {
    const suffix = `（${n}）`;
    const candidate = `${base.slice(0, BOARD_TITLE_MAX - suffix.length).trimEnd()}${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }

  // 极端情况下（同名 999 块）退回时间戳后缀，仍然保证不重名且不超长
  const suffix = `（${Date.now().toString(36)}）`;
  return `${base.slice(0, BOARD_TITLE_MAX - suffix.length).trimEnd()}${suffix}`;
}
