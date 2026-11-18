import { request, type ApiResult } from "../auth/authApi";

/** 复制白板到自己的空间（元素 + 图片资产会被复制并重映射）。 */

export type CopyBoardResult = {
  id: string;
  title: string;
  spaceId: string;
  elementCount: number;
  assetCount: number;
  skippedElements: number;
};

export function copyBoardToSpace(
  boardId: string,
  input: { shareToken?: string | null; title?: string; spaceId?: string } = {},
): Promise<ApiResult<CopyBoardResult>> {
  const { shareToken, title, spaceId } = input;
  return request<CopyBoardResult>(`/api/boards/${encodeURIComponent(boardId)}/copy`, {
    method: "POST",
    headers: shareToken ? { "x-share-token": shareToken } : undefined,
    body: JSON.stringify({ title: title?.trim() || undefined, spaceId }),
  });
}
