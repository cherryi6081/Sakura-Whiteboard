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
};

export type BoardList = { boards: BoardListItem[]; nextCursor: string | null };

export type CreatedBoard = {
  id: string;
  title: string;
  ownerType: "user" | "guest";
  createdAt: string;
};

export function fetchBoards(limit = 20): Promise<ApiResult<BoardList>> {
  return request<BoardList>(`/api/boards?limit=${limit}`);
}

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

export function createBoard(title?: string): Promise<ApiResult<CreatedBoard>> {
  return request<CreatedBoard>("/api/boards", {
    method: "POST",
    body: JSON.stringify(title ? { title } : {}),
  });
}

export const ROLE_LABEL: Record<string, string> = {
  owner: "我创建的",
  editor: "可编辑",
  viewer: "只读",
};
