import { deleteBoard, type DeleteBoardResult } from "./boardsApi";
import { clearBoardCache } from "../store/cacheDb";

/**
 * 删除白板（回收站设计稿 §08「本地快照要一起清」）。
 *
 * 只清 IndexedDB 里的缩略图快照：白板本体还在服务端回收站，30 天内可以恢复；
 * 恢复后回到列表时会按需重新生成缩略图。清快照失败不阻塞删除，最多留一张过期图。
 */
export async function moveBoardToTrash(boardId: string): Promise<DeleteBoardResult | null> {
  const result = await deleteBoard(boardId);
  if (!result.ok) return null;
  await clearBoardCache(boardId);
  return result.data;
}
