import { migrateBoardThumbs } from "../store/cacheDb";
import { GUEST_OWNER, migrateRecentBoards, ownerTag, userOwner } from "../boards/recentBoards";

/**
 * 临时板转入账号成功后的本机数据搬家（服务端不参与）：
 * - 缩略图：`thumbs` 主键是 `[owner, boardId]`，从 `guest` 搬到 `user:<id>`，卡片不会突然没了图；
 * - 最近打开：游客那份里「真正转过去的那批」搬到账号那份，其余游客记录原样保留。
 *
 * 都是可重建的派生物，失败只影响本机展示，不回滚服务端已经完成的转入。
 */
export async function migrateGuestLocalData(userId: string, boardIds: readonly string[]): Promise<void> {
  if (boardIds.length === 0) return;
  const target = userOwner(userId);
  migrateRecentBoards(GUEST_OWNER, target, boardIds);
  try {
    await migrateBoardThumbs(ownerTag(GUEST_OWNER), ownerTag(target), boardIds);
  } catch (err) {
    console.warn("[claim] 缩略图迁移失败，进板后会重新生成", err);
  }
}
