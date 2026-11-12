import { exportToBlob } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { readAllBoardThumbs, readBoardThumb, writeBoardThumb } from "../store/cacheDb";
import {
  THUMB_MAX_EDGE,
  THUMB_MIME,
  THUMB_QUALITY,
  liveElements,
  shouldCapture,
  thumbSignature,
} from "./thumbPolicy";

/**
 * 首帧快照链路（前端 IndexedDB `wb-cache` / `thumbs` store）。
 *
 * 写入时机：画布 API 就绪、缓存/快照元素已灌入之后，等字体与两帧渲染完成，
 * 再在空闲回调里导出。此时看到的就是"进板第一眼"的画面。
 *
 * 跳过条件：同一块板已有快照且内容指纹一致 → 直接返回，反复进出不重拍。
 * 失败回退：导出/写盘任何一步失败都只打日志，卡片继续用线稿占位，不影响画布。
 *
 * 为什么不放服务端 assets：缩略图是纯展示、可重建的派生物，上传会多一条
 * 鉴权 + 存储 + 清理链路；`boards.thumbnail_url` 字段保留未用，日后要做跨设备
 * 缩略图再补上传接口即可。
 */
export function scheduleThumbCapture(api: ExcalidrawImperativeAPI, boardId: string): void {
  const run = () => {
    void (async () => {
      try {
        await document.fonts?.ready;
      } catch {
        /* 字体接口不可用就直接拍 */
      }
      // 连续两帧：第一帧等 updateScene 落到画布，第二帧等浏览器完成绘制
      requestAnimationFrame(() => {
        requestAnimationFrame(() => void captureBoardThumb(api, boardId));
      });
    })();
  };

  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(run, { timeout: 1500 });
  } else {
    window.setTimeout(run, 300);
  }
}

export async function captureBoardThumb(api: ExcalidrawImperativeAPI, boardId: string): Promise<void> {
  try {
    const elements = api.getSceneElements();
    const signature = thumbSignature(elements);
    if (!signature) return;

    const previous = await readBoardThumb(boardId).catch(() => null);
    if (!shouldCapture(previous, signature)) return;

    const blob = await exportToBlob({
      elements: liveElements(elements) as never,
      files: api.getFiles(),
      appState: {
        ...api.getAppState(),
        exportBackground: true,
        exportWithDarkMode: false,
        viewBackgroundColor: "#ffffff",
      },
      mimeType: THUMB_MIME,
      quality: THUMB_QUALITY,
      maxWidthOrHeight: THUMB_MAX_EDGE,
      exportPadding: 12,
    });

    if (!(blob instanceof Blob) || blob.size === 0) return;
    await writeBoardThumb({ boardId, blob, signature });
  } catch (err) {
    console.warn("[boards] 首帧缩略图失败，卡片回退线稿占位", err);
  }
}

/** 列表页一次性取出缩略图并转成可直接给 <img> 用的 objectURL。 */
export async function loadThumbUrls(): Promise<Record<string, string>> {
  const records = await readAllBoardThumbs();
  const urls: Record<string, string> = {};
  for (const [boardId, record] of records) {
    if (!(record.blob instanceof Blob) || record.blob.size === 0) continue;
    urls[boardId] = URL.createObjectURL(record.blob);
  }
  return urls;
}
