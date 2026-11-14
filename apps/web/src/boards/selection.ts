/**
 * 批量选择的纯逻辑（设计稿 boards-bulk-select §03/§05/§07）。
 *
 * 这里只放不碰 DOM 的规则：勾选态、区间选择、可执行目标、网格列数。
 * 页面只负责把 Set 交给接口，把所有「哪些卡能删 / 能置顶」的判断集中在这里，
 * 避免工具条、确认框、撤销 toast 各写一份权限口径。
 */

export type SelectableCard = {
  id: string;
  title: string;
  role: string;
  pinned?: boolean;
  guest?: boolean;
};

export type SelectionState = "none" | "some" | "all";

/**
 * 宽度优先：卡片宽度只由列宽决定，四列直接均分内容区（扣掉列间距）并铺满，不因高度不足而缩小。
 * 缩略图 16:10，卡片高度随之确定；三行放不下时由页面出现纵向滚动，而不是压小卡片。
 * 宽度不够 4 列时按最小卡宽 140 减少列数，卡片仍铺满。
 */
export const BOARD_GRID_GAP = 16;
export const BOARD_MAX_COLUMNS = 4;
const CARD_MIN_WIDTH = 140;

export type BoardsLayout = { cardWidth: number; columns: number };

/** @param width 网格容器内容宽度 */
export function boardsLayout({
  width,
  gap = BOARD_GRID_GAP,
}: {
  width: number;
  gap?: number;
}): BoardsLayout {
  const columns = Math.max(
    1,
    Math.min(BOARD_MAX_COLUMNS, Math.floor((width + gap) / (CARD_MIN_WIDTH + gap))),
  );
  const cardWidth = Math.max(CARD_MIN_WIDTH, Math.floor((width - (columns - 1) * gap) / columns));
  return { cardWidth, columns };
}

/** 全选框三态：只看当前页；0 张 = none，满页 = all，其余 = some。 */
export function selectionState(ids: readonly string[], selected: ReadonlySet<string>): SelectionState {
  if (ids.length === 0) return "none";
  let count = 0;
  for (const id of ids) if (selected.has(id)) count += 1;
  if (count === 0) return "none";
  if (count === ids.length) return "all";
  return "some";
}

/**
 * Shift 区间：从锚点到目标（含两端），按视觉顺序。
 * 无锚点 / 目标不在当前页时退化为单选目标。
 */
export function rangeIds(order: readonly string[], anchorId: string | null, targetId: string): string[] {
  const target = order.indexOf(targetId);
  if (target < 0) return [];
  const anchor = anchorId ? order.indexOf(anchorId) : -1;
  if (anchor < 0) return [targetId];
  const start = Math.min(anchor, target);
  const end = Math.max(anchor, target);
  return order.slice(start, end + 1);
}

export type BatchTargets = {
  /** 真正会执行动作的卡 */
  targets: SelectableCard[];
  /** 会在确认框里标「跳过」的卡 */
  skipped: SelectableCard[];
};

function selectedCards(cards: readonly SelectableCard[], selected: ReadonlySet<string>): SelectableCard[] {
  return cards.filter((card) => selected.has(card.id));
}

/**
 * 批量删除：只有 owner 能删。游客的临时板 owner 也是 owner，
 * 批量接口按 cookie 归属走物理删除，因此同样算可删目标。
 * editor / viewer 都算跳过，确认框据此显示实际删除数。
 */
export function trashTargets(cards: readonly SelectableCard[], selected: ReadonlySet<string>): BatchTargets {
  const picked = selectedCards(cards, selected);
  return {
    targets: picked.filter((card) => card.role === "owner"),
    skipped: picked.filter((card) => card.role !== "owner"),
  };
}

/** 批量置顶：owner / editor 可改（与 PATCH /boards/:id/pin 一致），viewer 跳过。 */
export function pinTargets(cards: readonly SelectableCard[], selected: ReadonlySet<string>): BatchTargets {
  const picked = selectedCards(cards, selected);
  return {
    targets: picked.filter((card) => (card.role === "owner" || card.role === "editor") && !card.guest),
    skipped: picked.filter((card) => card.role !== "owner" && card.role !== "editor"),
  };
}

/** 全部已置顶时才把按钮文案切成「取消置顶」；混选按「批量置顶」处理。 */
export function allPinned(cards: readonly SelectableCard[], selected: ReadonlySet<string>): boolean {
  const { targets } = pinTargets(cards, selected);
  return targets.length > 0 && targets.every((card) => card.pinned === true);
}
