import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { fetchSnapshot } from "../collab/boardApi";
import { clearBoardCache, readCachedScene, touchCache, writeCachedScene } from "../store/cacheDb";

export type BoardScene = {
  elements: readonly ExcalidrawElement[];
  /** 首帧来源：本地缓存（最快）/ 服务端快照 / 空场景 */
  source: "cache" | "snapshot" | "placeholder";
  seq: number;
  /** 读取缓存耗时（毫秒），验收"缓存先行"用 */
  loadMs: number;
};

/**
 * M2-C5 启动顺序（见开发文档 §7.2.3）：
 *
 * 1. 先读本地 IndexedDB 缓存，直接交给画布渲染（刷新后不等网络）；
 * 2. 没有缓存时才请求 `GET /api/boards/:id/snapshot`，拿到整板元素与 `last_seq`；
 * 3. 随后 `BoardCollab` 在 join 后用缓存 seq 作 `since` 增量补拉。
 *
 * 缓存按 `[boardId, elementId]` 复合键存，所以不同板不会互相污染。
 * 服务端 404（板被删/归档/private）时顺手清掉本地缓存，避免永久泄漏。
 *
 * M3：冷启动快照落盘要经过 Web Locks 写者门禁（`canWriteCache`）。非写者标签跳过写，
 * 由写者标签或后续 op 落盘补齐，避免同板两个标签冷启动时互相覆盖快照。
 */
export async function loadBoardScene(
  boardId: string,
  options: { canWriteCache?: () => boolean; shareToken?: string | null } = {},
): Promise<BoardScene> {
  const started = performance.now();

  try {
    const cached = await readCachedScene(boardId);
    // lastAccessAt > 0 表示确实有缓存记录（空板也算命中，避免重复请求快照）
    if (cached && cached.lastAccessAt > 0) {
      void touchCache(boardId);
      return {
        elements: cached.elements as unknown as ExcalidrawElement[],
        source: "cache",
        seq: cached.seq,
        loadMs: performance.now() - started,
      };
    }
  } catch (err) {
    console.warn("[board] 读取本地缓存失败，回退到服务端快照", err);
  }

  const snapshot = await fetchSnapshot(boardId, options.shareToken);
  if (snapshot.ok) {
    const elements = snapshot.data.elements as unknown as ExcalidrawElement[];
    // M3：非 Web Locks 写者只读缓存，不落这份冷启动快照
    if (options.canWriteCache?.() ?? true) {
      try {
        await writeCachedScene(boardId, snapshot.data.elements, snapshot.data.seq);
      } catch (err) {
        console.warn("[board] 写入本地缓存失败", err);
      }
    }
    return { elements, source: "snapshot", seq: snapshot.data.seq, loadMs: performance.now() - started };
  }

  if (snapshot.status === 404) {
    await clearBoardCache(boardId).catch(() => undefined);
  } else {
    console.warn(`[board] 快照接口失败 status=${snapshot.status} code=${snapshot.code}`);
  }
  return { elements: [], source: "placeholder", seq: 0, loadMs: performance.now() - started };
}
