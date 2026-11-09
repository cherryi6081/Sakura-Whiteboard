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
