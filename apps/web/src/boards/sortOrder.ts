/**
 * 拖拽排序的纯逻辑（设计稿 boards-drag-sort §02 / §06）。
 *
 * 分组由「是否置顶」推导，不新增组实体：置顶组恒在上，两组互不交错。
 * 这里只做数组运算，不碰 DOM / 指针，便于单测覆盖落点与邻居。
 */

export type SortableCard = { id: string; pinned: boolean };

export type BoardGroups<T> = { pinned: T[]; others: T[] };

/** 按入参顺序拆成置顶组与普通组（入参应已按当前排序规则排好）。 */
export function splitGroups<T extends SortableCard>(cards: readonly T[]): BoardGroups<T> {
  const pinned: T[] = [];
  const others: T[] = [];
  for (const card of cards) (card.pinned ? pinned : others).push(card);
  return { pinned, others };
}

/** 把 from 位置的元素移到 to 位置（to 是移除源元素之后的目标下标）。 */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(from, 1);
  if (item === undefined) return [...list];
  next.splice(Math.min(to, next.length), 0, item);
  return next;
}

/**
 * 落点两侧的邻居：接口只认「放在谁和谁之间」。
 * `position` 是插入后的目标下标。
 */
export function neighborsAt<T extends { id: string }>(
  list: readonly T[],
  position: number,
): { beforeId: string | null; afterId: string | null } {
  return {
    beforeId: list[position - 1]?.id ?? null,
    afterId: list[position + 1]?.id ?? null,
  };
}

/**
 * 指针 / 焦点在某一组里的落点下标（0…len）。
 *
 * 用目标卡中线判定而不是「指针到卡片的距离」：手一抖不会在两张卡之间来回跳。
 * `horizontal` 为 true 时比较 X（多列横排），否则比较 Y（单列竖排）。
 * 判定前先排除源卡自身，返回的下标已是「移除源卡之后」的位置。
 */
export function dropIndex(
  rects: readonly { id: string; left: number; top: number; width: number; height: number }[],
  pointer: { x: number; y: number },
  sourceId: string,
  horizontal: boolean,
): number {
  const rest = rects.filter((rect) => rect.id !== sourceId);
  let index = 0;
  for (const rect of rest) {
    const center = horizontal ? rect.left + rect.width / 2 : rect.top + rect.height / 2;
    const value = horizontal ? pointer.x : pointer.y;
    if (value > center) index += 1;
    else break;
  }
  return index;
}
