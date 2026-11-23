import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { fetchSnapshot, fetchWatermark } from "../collab/boardApi";
import { clearBoardCache, readCachedScene, touchCache, writeCachedScene } from "../store/cacheDb";

export type BoardScene = {
  elements: readonly ExcalidrawElement[];
  /** 首帧来源：本地缓存（最快）/ 服务端快照 / 空场景 */
  source: "cache" | "snapshot" | "placeholder";
  seq: number;
  /** 读取缓存耗时（毫秒），验收"缓存先行"用 */
  loadMs: number;
  /**
   * 首帧与服务端权威水位的关系：
   * - `fresh`：已校验一致，或本来就是权威快照；
   * - `stale`：水位显示本地落后，但权威快照没取到，只能先用缓存；
   * - `offline`：水位请求失败/浏览器离线，缓存是否最新未知。
   * 非 fresh 时界面给出"未同步"提示，联网后由 join 补拉收敛。
   */
  sync: "fresh" | "stale" | "offline";
};

/**
 * 启动顺序（见开发文档 §7.2.3，v1.2 起加开板前水位校验）：
 *
 * 1. 读本地 IndexedDB 缓存 **与** 请求 `GET /api/boards/:id/watermark` 并行；
 * 2. 命中缓存时先比较水位：`lastSeq <= 缓存 seq` 才允许把缓存当首帧；
 *    落后则等 `GET /snapshot` 的权威整板，绝不先画旧缓存再补拉 delete op；
 * 3. 没有缓存时直接走快照（快照本身就是权威的，无需再多一次校验）；
 * 4. 水位/快照请求失败或浏览器离线时，退回缓存直接开板并标记 `sync`，
 *    不阻塞编辑；随后 `BoardCollab` 在 join 后用缓存 seq 补拉收敛。
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
  const online = typeof navigator === "undefined" ? true : navigator.onLine !== false;

  // 与读缓存并行发起：命中最新缓存时，额外开销只有 max(缓存, 水位 RTT)，
  // 而不是两者串行相加。
  const watermarkPending = online ? fetchWatermark(boardId, options.shareToken) : null;

  let cached: Awaited<ReturnType<typeof readCachedScene>> = null;
  try {
    cached = await readCachedScene(boardId);
  } catch (err) {
    console.warn("[board] 读取本地缓存失败，回退到服务端快照", err);
  }

  if (cached && cached.lastAccessAt > 0) {
    const cachedElements = cached.elements as unknown as ExcalidrawElement[];

    if (!watermarkPending) {
      // 浏览器明确离线：不等网络，缓存直开并提示未同步
      void touchCache(boardId);
      return { elements: cachedElements, source: "cache", seq: cached.seq, sync: "offline", loadMs: performance.now() - started };
    }

    const watermark = await watermarkPending;
    if (!watermark.ok) {
      if (watermark.status === 404) {
        await clearBoardCache(boardId).catch(() => undefined);
        return { elements: [], source: "placeholder", seq: 0, sync: "fresh", loadMs: performance.now() - started };
      }
      console.warn(`[board] 水位校验失败 status=${watermark.status} code=${watermark.code}`);
      // 服务端有响应（5xx/解析失败）说明网络还在：再要一次权威整板，避免用可能的旧缓存开板；
      // 纯网络失败（status=0，离线）不再多发请求，直接缓存直开。
      if (watermark.status > 0) {
        const retry = await fetchSnapshot(boardId, options.shareToken);
        if (retry.ok) {
          const elements = retry.data.elements as unknown as ExcalidrawElement[];
          if (options.canWriteCache?.() ?? true) {
            try {
              await writeCachedScene(boardId, retry.data.elements, retry.data.seq);
            } catch (err) {
              console.warn("[board] 写入本地缓存失败", err);
            }
          }
          return { elements, source: "snapshot", seq: retry.data.seq, sync: "fresh", loadMs: performance.now() - started };
        }
        if (retry.status === 404) {
          await clearBoardCache(boardId).catch(() => undefined);
          return { elements: [], source: "placeholder", seq: 0, sync: "fresh", loadMs: performance.now() - started };
        }
      }
      void touchCache(boardId);
      return {
        elements: cachedElements,
        source: "cache",
        seq: cached.seq,
        sync: watermark.status === 0 ? "offline" : "stale",
        loadMs: performance.now() - started,
      };
    }

    if (watermark.data.lastSeq <= cached.seq) {
      // 缓存已覆盖服务端全部 op，可以安全地当首帧
      void touchCache(boardId);
      return { elements: cachedElements, source: "cache", seq: cached.seq, sync: "fresh", loadMs: performance.now() - started };
    }

    // 本地落后（例如清空发生在其它浏览器）：等权威整板，先不画旧缓存
    const snapshot = await fetchSnapshot(boardId, options.shareToken);
    if (snapshot.ok) {
      const elements = snapshot.data.elements as unknown as ExcalidrawElement[];
      if (options.canWriteCache?.() ?? true) {
        try {
          await writeCachedScene(boardId, snapshot.data.elements, snapshot.data.seq);
        } catch (err) {
          console.warn("[board] 写入本地缓存失败", err);
        }
      }
      return { elements, source: "snapshot", seq: snapshot.data.seq, sync: "fresh", loadMs: performance.now() - started };
    }
    if (snapshot.status === 404) {
      await clearBoardCache(boardId).catch(() => undefined);
      return { elements: [], source: "placeholder", seq: 0, sync: "fresh", loadMs: performance.now() - started };
    }
    console.warn(`[board] 落后但权威快照失败 status=${snapshot.status} code=${snapshot.code}`);
    void touchCache(boardId);
    return { elements: cachedElements, source: "cache", seq: cached.seq, sync: "stale", loadMs: performance.now() - started };
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
    return { elements, source: "snapshot", seq: snapshot.data.seq, sync: "fresh", loadMs: performance.now() - started };
  }

  if (snapshot.status === 404) {
    await clearBoardCache(boardId).catch(() => undefined);
    return { elements: [], source: "placeholder", seq: 0, sync: "fresh", loadMs: performance.now() - started };
  }
  console.warn(`[board] 快照接口失败 status=${snapshot.status} code=${snapshot.code}`);
  return {
    elements: [],
    source: "placeholder",
    seq: 0,
    sync: online && snapshot.status !== 0 ? "fresh" : "offline",
    loadMs: performance.now() - started,
  };
}
