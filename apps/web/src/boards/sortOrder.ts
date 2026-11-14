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
 * 单列（mobile）比较 Y；多列网格是**二维**判定：先按 Y 选行（行间隙取更近的一行），
 * 再在行内按 X 定位。只比较 X 会把所有行都算成第一行，导致纵向拖拽不生效。
 * 判定前先排除源卡自身，返回的下标已是「移除源卡之后」的位置。
 */
export function dropIndex(
  rects: readonly { id: string; left: number; top: number; width: number; height: number }[],
  pointer: { x: number; y: number },
  sourceId: string,
  horizontal: boolean,
): number {
  type Rect = { id: string; left: number; top: number; width: number; height: number };
  const rest: Rect[] = rects.filter((rect) => rect.id !== sourceId);
  if (rest.length === 0) return 0;

  if (!horizontal) {
    let index = 0;
    for (const rect of rest) {
      if (pointer.y > rect.top + rect.height / 2) index += 1;
      else break;
    }
    return index;
  }

  // 卡片按视觉顺序（行优先）传入，把相邻且 top 相同的归为一行
  type Row = { top: number; bottom: number; start: number; items: Rect[] };
  const rows: Row[] = [];
  for (const rect of rest) {
    const current = rows[rows.length - 1];
    if (current && Math.abs(current.top - rect.top) <= 2) {
      current.items.push(rect);
      current.bottom = Math.max(current.bottom, rect.top + rect.height);
    } else {
      const start = current ? current.start + current.items.length : 0;
      rows.push({ top: rect.top, bottom: rect.top + rect.height, start, items: [rect] });
    }
  }

  // 指针落在某一行带内则直接选它；落在行间隙时取纵向更近的一行
  let picked = rows[0]!;
  let best = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const distance = pointer.y < row.top ? row.top - pointer.y : pointer.y > row.bottom ? pointer.y - row.bottom : 0;
    if (distance < best) {
      best = distance;
      picked = row;
    }
  }

  let within = 0;
  for (const rect of picked.items) {
    if (pointer.x > rect.left + rect.width / 2) within += 1;
    else break;
  }
  return picked.start + within;
}
