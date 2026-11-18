import { request, type ApiResult } from "../auth/authApi";

/**
 * 编辑权限申请 REST 客户端。
 *
 * 分享 token 只跟 `x-share-token` 头走（与画布/导出同一口径），不写回 URL。
 */

export type EditRequestStatus = "pending" | "approved" | "rejected";

export type EditRequest = {
  id: string;
  boardId: string;
  requesterId: string;
  note: string | null;
  status: EditRequestStatus;
  createdAt: string;
  decidedAt: string | null;
};

export type EditRequestSummary = EditRequest & {
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
};

const shareHeaders = (shareToken?: string | null): Record<string, string> | undefined =>
  shareToken ? { "x-share-token": shareToken } : undefined;

export function requestEditAccess(
  boardId: string,
  shareToken?: string | null,
  note?: string,
): Promise<ApiResult<{ request: EditRequest }>> {
  return request<{ request: EditRequest }>(`/api/boards/${encodeURIComponent(boardId)}/edit-requests`, {
    method: "POST",
    headers: shareHeaders(shareToken),
    body: JSON.stringify({ note: note ?? undefined }),
  });
}

export function fetchMyEditRequest(
  boardId: string,
  shareToken?: string | null,
): Promise<ApiResult<{ request: EditRequest | null; role: string }>> {
  return request<{ request: EditRequest | null; role: string }>(
    `/api/boards/${encodeURIComponent(boardId)}/edit-requests/mine`,
    { headers: shareHeaders(shareToken) },
  );
}

export function fetchEditRequests(
  boardId: string,
  all = false,
): Promise<ApiResult<{ boardId: string; requests: EditRequestSummary[] }>> {
  return request<{ boardId: string; requests: EditRequestSummary[] }>(
    `/api/boards/${encodeURIComponent(boardId)}/edit-requests${all ? "?all=1" : ""}`,
  );
}

export function decideEditRequest(
  boardId: string,
  requestId: string,
  status: "approved" | "rejected",
): Promise<ApiResult<{ request: EditRequest; granted: boolean }>> {
  return request<{ request: EditRequest; granted: boolean }>(
    `/api/boards/${encodeURIComponent(boardId)}/edit-requests/${encodeURIComponent(requestId)}`,
    { method: "PATCH", body: JSON.stringify({ status }) },
  );
}
