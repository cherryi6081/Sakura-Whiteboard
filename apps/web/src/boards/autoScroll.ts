/**
 * 拖拽排序时的边缘自动滚动（列表页）。
 *
 * 只做纯计算：给定指针的视口坐标与滚动区域上下边界，返回**每帧**应滚动的像素
 * （负 = 向上，正 = 向下，0 = 不滚）。真正的滚动与帧循环在 `BoardsPage` 里用 rAF 驱动。
 *
 * 规则：
 * - 指针离开滚动区域（含移出视口）→ 0，调用方据此停掉 rAF；
 * - 距边缘 `edge` 内开始滚动，越近越快；压到边缘时保持最大速度；
 * - 速度取整后至少 1px，避免「刚进边缘时因不足 1px 而没反应」。
 */

/** 距视口上/下边缘多少像素内开始自动滚动 */
export const AUTO_SCROLL_EDGE = 64;

/** 每帧最大滚动距离（约 60fps 下 ≈ 1080px/s） */
export const AUTO_SCROLL_MAX_STEP = 18;

export function edgeScrollStep(
  pointerY: number,
  top: number,
  bottom: number,
  edge: number = AUTO_SCROLL_EDGE,
  maxStep: number = AUTO_SCROLL_MAX_STEP,
): number {
  if (!Number.isFinite(pointerY) || bottom <= top || edge <= 0 || maxStep <= 0) return 0;
  // 指针在可视区之外：不滚，调用方应停止帧循环
  if (pointerY < top || pointerY > bottom) return 0;

  const distanceToTop = pointerY - top;
  if (distanceToTop < edge) {
    // 越靠近顶边 ratio 越大；压到顶边时 ratio = 1
    const ratio = Math.min(1, (edge - distanceToTop) / edge);
    return -Math.max(1, Math.round(maxStep * ratio));
  }

  const distanceToBottom = bottom - pointerY;
  if (distanceToBottom < edge) {
    const ratio = Math.min(1, (edge - distanceToBottom) / edge);
    return Math.max(1, Math.round(maxStep * ratio));
  }

  return 0;
}
