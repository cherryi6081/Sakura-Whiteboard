/**
 * 「我的白板」列表的排序与分页规则（纯函数，可在 Node 里单测）。
 *
 * 排序契约：置顶优先 → 最近打开倒序 → id 兜底（同一时间戳也不抖序）。
 * 手动模式（用户拖过某一组后）在同一分组内改为按 `rank` 升序，没排过的仍回落到时间。
 * 分页契约：每页 6 张，客户端按页累加。服务端一次最多取 30 条，
 * 排序在服务端已经做过一遍，这里再算一次是为了游客列表与刚置顶后的局部更新
 * 走同一套规则，不依赖服务端返回顺序。
 */

export const BOARDS_PAGE_SIZE = 6;

export type SortMode = "auto" | "manual";

export type PinnableBoard = {
  id: string;
  lastEditedAt: string;
  /** 游客/本机列表用的布尔标记 */
  pinned?: boolean;
  /** 登录用户列表用的服务端时间戳 */
  pinnedAt?: string | null;
  /** 手动顺序；null = 这一块还没有 rank（回落到时间） */
  rank?: number | null;
};

export function isPinned(board: PinnableBoard): boolean {
  return board.pinned === true || Boolean(board.pinnedAt);
}

function rankOf(board: PinnableBoard): number | null {
  return typeof board.rank === "number" && Number.isFinite(board.rank) ? board.rank : null;
}

export function sortBoards<T extends PinnableBoard>(boards: readonly T[], mode: SortMode = "auto"): T[] {
  return [...boards].sort((a, b) => {
    const pinDiff = Number(isPinned(b)) - Number(isPinned(a));
    if (pinDiff !== 0) return pinDiff;

    if (mode === "manual") {
      const aRank = rankOf(a);
      const bRank = rankOf(b);
      if (aRank !== null && bRank !== null && aRank !== bRank) return aRank - bRank;
      // 有 rank 的排在没 rank 的前面（新板 / 置顶后又取消置顶的板回落到时间比较）
      if (aRank === null !== (bRank === null)) return aRank === null ? 1 : -1;
    }

    const aTime = Date.parse(a.lastEditedAt);
    const bTime = Date.parse(b.lastEditedAt);
    const aValid = Number.isFinite(aTime);
    const bValid = Number.isFinite(bTime);
    // 脏时间戳排到有效时间之后，避免把一条坏数据顶到列表首位
    if (aValid !== bValid) return aValid ? -1 : 1;
    if (aValid && aTime !== bTime) return bTime - aTime;

    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** 「加载更多」：第 page 页时展示前 page × 6 张。 */
export function visibleBoards<T>(boards: readonly T[], page: number, pageSize = BOARDS_PAGE_SIZE): T[] {
  const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
  return boards.slice(0, safePage * pageSize);
}

export function hasMoreBoards(total: number, page: number, pageSize = BOARDS_PAGE_SIZE): boolean {
  const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
  return safePage * pageSize < total;
}
