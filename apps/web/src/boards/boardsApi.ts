/**
 * 白板列表与新建的 REST 客户端（M7 视图提前落地，接口为 M5 已实现的
 * `GET /api/boards` 与 `POST /api/boards`；不改服务端）。
 */

import { request, type ApiResult } from "../auth/authApi";

export type BoardRole = "owner" | "editor" | "viewer";

export type BoardListItem = {
  id: string;
  title: string;
  role: BoardRole | string;
  lastEditedAt: string;
  /** 服务端置顶时间；null = 未置顶。列表按「置顶优先，其次最近打开」返回 */
  pinnedAt?: string | null;
  /** 手动顺序（仅 sortMode = manual 时有效）；null = 尚未排过 */
  rank?: number | null;
  /** 团队空间卡片展示「谁创建」；个人空间不展示 */
  ownerName?: string;
  isOwn?: boolean;
};

export type BoardSortMode = "auto" | "manual";

export type BoardList = {
  boards: BoardListItem[];
  sortMode: BoardSortMode;
  nextOffset: number | null;
  /** 实际查询的空间；缺省为个人空间 */
  spaceId?: string;
  spaceRole?: BoardRole | string;
};

export function fetchBoards(limit = 20, offset = 0, spaceId?: string): Promise<ApiResult<BoardList>> {
  const space = spaceId ? `&space=${encodeURIComponent(spaceId)}` : "";
  return request<BoardList>(`/api/boards?limit=${limit}&offset=${offset}${space}`);
}

/**
 * 把白板放到两个邻居之间（owner/editor/viewer 都能排自己的列表）。
 * 首次调用会把整组当前顺序落成 rank 并把用户切到手动模式。
 */
export function reorderBoard(
  boardId: string,
  neighbors: { beforeId: string | null; afterId: string | null },
): Promise<ApiResult<{ id: string; rank: number; sortMode: BoardSortMode }>> {
  return request(`/api/boards/${encodeURIComponent(boardId)}/order`, {
    method: "PATCH",
    body: JSON.stringify(neighbors),
  });
}

/** 恢复自动排序会清空该用户全部 rank，列表立刻按时间重排。 */
export function setSortMode(mode: BoardSortMode): Promise<ApiResult<{ mode: BoardSortMode }>> {
  return request<{ mode: BoardSortMode }>("/api/boards/sort-mode", {
    method: "PUT",
    body: JSON.stringify({ mode }),
  });
}
export type CreatedBoard = {
  id: string;
  title: string;
  ownerType: "user" | "guest";
  createdAt: string;
};

/** 置顶 / 取消置顶（仅创建者）。游客板走本地 `recentBoards`，不会调用这里。 */
export function setBoardPinned(
  boardId: string,
  pinned: boolean,
): Promise<ApiResult<{ id: string; pinnedAt: string | null }>> {
  return request(`/api/boards/${encodeURIComponent(boardId)}/pin`, {
    method: "PATCH",
    body: JSON.stringify({ pinned }),
  });
}

export type BatchItemResult = {
  id: string;
  ok: boolean;
  reason?: string;
  role?: string;
  pinnedAt?: string | null;
  deletedAt?: string;
  purgeAt?: string;
  /** 游客物理删除的逐项标记 */
  purged?: boolean;
};

export type BatchPinResult = {
  pinned: boolean;
  items: BatchItemResult[];
  okCount: number;
  skippedCount: number;
};

/** 批量置顶 / 取消置顶（owner / editor）。 */
export function batchPinBoards(boardIds: string[], pinned: boolean): Promise<ApiResult<BatchPinResult>> {
  return request<BatchPinResult>("/api/boards/batch/pin", {
    method: "POST",
    body: JSON.stringify({ ids: boardIds, pinned }),
  });
}

export type BatchTrashResult = {
  /** purged = 游客物理删除，没有 30 天回收站 */
  mode: "trash" | "purged";
  items: BatchItemResult[];
  okCount: number;
  skippedCount: number;
};

/** 批量删除：登录成员移入回收站，游客物理删除；逐项返回，失败项由调用方提示。 */
export function batchTrashBoards(boardIds: string[]): Promise<ApiResult<BatchTrashResult>> {
  return request<BatchTrashResult>("/api/boards/batch/trash", {
    method: "POST",
    body: JSON.stringify({ ids: boardIds }),
  });
}

export function createBoard(
  title?: string,
  spaceId?: string,
  pinnedIds?: string[],
): Promise<ApiResult<CreatedBoard>> {
  const body: { title?: string; spaceId?: string; pinnedIds?: string[] } = {};
  if (title) body.title = title;
  if (spaceId) body.spaceId = spaceId;
  // 游客的置顶只在本机：带上去让服务端淘汰时排除（登录用户服务端会忽略）
  if (pinnedIds && pinnedIds.length > 0) body.pinnedIds = pinnedIds;
  return request<CreatedBoard>("/api/boards", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * 进入白板时累加打开次数。
 *
 * fire-and-forget：不 await、不阻塞首帧；`keepalive` 保证跳转/关闭页面时也能发出。
 * 服务端是一条主键单行 UPDATE，成本远低于一次 snapshot 读。
 */
export function markBoardOpened(boardId: string): void {
  void fetch(`/api/boards/${encodeURIComponent(boardId)}/opened`, {
    method: "POST",
    credentials: "include",
    keepalive: true,
  }).catch(() => {
    /* 统计失败不影响进板 */
  });
}

/** 重命名（owner / editor）；服务端不改 `last_edited_at`。 */
export function renameBoard(boardId: string, title: string): Promise<ApiResult<{ id: string; title: string }>> {
  return request<{ id: string; title: string }>(`/api/boards/${encodeURIComponent(boardId)}`, {
    method: "PATCH",
    body: JSON.stringify({ title }),
  });
}

export type CreatedShareLink = {
  id: string;
  boardId: string;
  permission: "read" | "edit";
  token: string;
  url: string;
  expiresAt: string | null;
  createdAt: string;
};

/** 生成分享链接（owner）；列表页「邀请协作者」用它复制只读链接。 */
export function createShareLink(
  boardId: string,
  permission: "read" | "edit" = "read",
): Promise<ApiResult<CreatedShareLink>> {
  return request<CreatedShareLink>(`/api/boards/${encodeURIComponent(boardId)}/share-links`, {
    method: "POST",
    body: JSON.stringify({ permission }),
  });
}

export const ROLE_LABEL: Record<string, string> = {
  owner: "我创建的",
  editor: "可编辑",
  viewer: "只读",
};

/* ---------------- 回收站（v1.2 第 1 步） ---------------- */

export type TrashBoardItem = {
  id: string;
  title: string;
  /** 第 5 步接入团队空间后是真实空间名，当前固定 null → 「个人空间」 */
  spaceName: string | null;
  deletedAt: string;
  /** deleted_at + 30 天；前端据此换算剩余天数 */
  purgeAt: string;
};

export type TrashList = {
  boards: TrashBoardItem[];
  total: number;
  allTotal: number;
  expiringSoon: number;
  nextOffset: number | null;
};

export type TrashFilter = "all" | "expiring";

export function fetchTrash(options: {
  offset?: number;
  limit?: number;
  filter?: TrashFilter;
} = {}): Promise<ApiResult<TrashList>> {
  const params = new URLSearchParams();
  params.set("limit", String(options.limit ?? 12));
  params.set("offset", String(options.offset ?? 0));
  params.set("filter", options.filter ?? "all");
  return request<TrashList>(`/api/boards/trash?${params.toString()}`);
}

/** 顶栏徽标只取数量，不拉整页。 */
export function fetchTrashCount(): Promise<ApiResult<{ count: number }>> {
  return request<{ count: number }>("/api/boards/trash/count");
}

export type DeleteBoardResult = {
  id: string;
  mode: "trash" | "purged";
  deletedAt: string | null;
  purgeAt: string | null;
};

/** 删除：登录 owner 走软删除；游客板由服务端直接物理删除。 */
export function deleteBoard(boardId: string): Promise<ApiResult<DeleteBoardResult>> {
  return request<DeleteBoardResult>(`/api/boards/${encodeURIComponent(boardId)}`, { method: "DELETE" });
}

export type RestoreBoardResult = {
  id: string;
  title: string;
  renamed: boolean;
  deletedAt: null;
};

export function restoreBoard(boardId: string): Promise<ApiResult<RestoreBoardResult>> {
  return request<RestoreBoardResult>(`/api/boards/${encodeURIComponent(boardId)}/restore`, {
    method: "POST",
  });
}

export function purgeBoard(boardId: string): Promise<ApiResult<{ id: string; purged: true }>> {
  return request<{ id: string; purged: true }>(
    `/api/boards/${encodeURIComponent(boardId)}/purge`,
    { method: "DELETE" },
  );
}

export function emptyTrash(): Promise<ApiResult<{ purged: number }>> {
  return request<{ purged: number }>("/api/boards/trash", { method: "DELETE" });
}
