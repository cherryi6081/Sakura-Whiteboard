/**
 * 列表手动排序的纯逻辑（设计稿 boards-drag-sort §3.2）。
 *
 * 客户端只传「左右的邻居」而不传「第几位」——分页只加载 6/30 条，
 * 客户端唯一确定的信息就是落点两侧是谁。服务端据此取中点 rank，
 * 间隙不足时整组按 `ORDER_STEP` 重排。
 */

/** 初始步长；每次落在两位之间取中点，理论上可用约 10 次后才需要重排 */
export const ORDER_STEP = 1024;

/** 判定「间隙过小」的阈值：小于它就重排整组，避免浮点精度把顺序写坏 */
export const MIN_GAP = 0.0001;

/**
 * 计算插到 `before` 与 `after` 之间可用的 rank。
 *
 * - 两侧都为 null：组内唯一一块，返回首个步长；
 * - 只有 after：落在组首，取 after 的一半（连续向组首插入会逐步减半，触底后重排）；
 * - 只有 before：落在组尾，`before + ORDER_STEP`；
 * - 两侧都有：取中点。
 *
 * 返回 null 表示邻居顺序异常（before >= after）或间隙不足，调用方应重排整组。
 */
export function rankBetween(before: number | null, after: number | null): number | null {
  if (before === null && after === null) return ORDER_STEP;

  if (before === null) {
    if (after === null) return ORDER_STEP;
    const rank = after / 2;
    return rank > MIN_GAP ? round8(rank) : null;
  }

  if (after === null) return round8(before + ORDER_STEP);

  if (!(before < after)) return null;
  if (after - before <= MIN_GAP * 2) return null;
  return round8((before + after) / 2);
}

export function round8(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

/**
 * 把一组 id 按视觉顺序落成 rank：1024, 2048, 3072…
 * 用于「首次拖动把该组当前顺序整体接管」与「间隙不足时整组重排」。
 */
export function materializeRanks(ids: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  ids.forEach((id, index) => map.set(id, ORDER_STEP * (index + 1)));
  return map;
}
