import type { SpaceRole, SpaceSummary } from "@whiteboard/shared";
import { request, type ApiResult } from "../auth/authApi";

/**
 * 空间 REST 客户端（设计稿「团队空间切换」§09 P0）。
 *
 * 没有 router 库：空间只作为列表页的 query 上下文（`/boards?space=sp_xxx`），
 * 这里的接口不负责导航，切空间由 `BoardsPage` 改写地址栏。
 */

export type { SpaceRole, SpaceSummary };

export type SpaceMember = {
  userId: string;
  displayName: string;
  email: string | null;
  color: string;
  role: SpaceRole;
  joinedAt: string;
};

export type SpaceInvite = {
  token: string;
  role: "editor" | "viewer";
  /** 站内相对地址 `/join/<token>` */
  url: string;
  expiresAt: string | null;
  expiresInDays: number;
};

export function fetchSpaces(): Promise<ApiResult<{ spaces: SpaceSummary[] }>> {
  return request<{ spaces: SpaceSummary[] }>("/api/spaces");
}

export function createSpace(name: string): Promise<ApiResult<SpaceSummary>> {
  return request<SpaceSummary>("/api/spaces", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export function fetchSpaceMembers(spaceId: string): Promise<ApiResult<{ members: SpaceMember[] }>> {
  return request<{ members: SpaceMember[] }>(`/api/spaces/${encodeURIComponent(spaceId)}/members`);
}

export function createSpaceInvite(
  spaceId: string,
  role: "editor" | "viewer" = "viewer",
): Promise<ApiResult<SpaceInvite>> {
  return request<SpaceInvite>(`/api/spaces/${encodeURIComponent(spaceId)}/invites`, {
    method: "POST",
    body: JSON.stringify({ role }),
  });
}

export function revokeSpaceInvite(
  spaceId: string,
  token: string,
): Promise<ApiResult<{ token: string; revoked: boolean }>> {
  return request(`/api/spaces/${encodeURIComponent(spaceId)}/invites/${encodeURIComponent(token)}`, {
    method: "DELETE",
  });
}

export type AcceptInviteResult = {
  spaceId: string;
  spaceName: string;
  role: SpaceRole;
  alreadyMember: boolean;
};

export function acceptSpaceInvite(token: string): Promise<ApiResult<AcceptInviteResult>> {
  return request<AcceptInviteResult>(`/api/invites/${encodeURIComponent(token)}/accept`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

/* ------------------------------------------------------------------------------------------
 * 生命周期
 * ---------------------------------------------------------------------------------------- */

export type LeaveSpaceResult = {
  spaceId: string;
  mode: "left";
  /** 退出后仍留在空间里的、自己创建的白板数（不随人走） */
  boardsKept: number;
};

export function leaveSpace(spaceId: string): Promise<ApiResult<LeaveSpaceResult>> {
  return request<LeaveSpaceResult>(`/api/spaces/${encodeURIComponent(spaceId)}/leave`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export type TransferSpaceResult = {
  spaceId: string;
  ownerId: string;
  previousOwnerId: string;
  previousOwnerRole: "editor";
};

export function transferSpaceOwner(spaceId: string, userId: string): Promise<ApiResult<TransferSpaceResult>> {
  return request<TransferSpaceResult>(`/api/spaces/${encodeURIComponent(spaceId)}/owner`, {
    method: "PUT",
    body: JSON.stringify({ userId }),
  });
}

export type DissolveSpaceResult = {
  spaceId: string;
  mode: "dissolved";
  boardsMoved: number;
  boardsTrashed: number;
  boardsAlreadyTrashed: number;
  retentionDays: number;
  purgeAt: string;
};

export function dissolveSpace(spaceId: string): Promise<ApiResult<DissolveSpaceResult>> {
  return request<DissolveSpaceResult>(`/api/spaces/${encodeURIComponent(spaceId)}`, {
    method: "DELETE",
  });
}
