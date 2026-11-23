import { exportToSvg, getCommonBounds } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { deleteBoardThumb, readAllBoardThumbs, readBoardThumb, writeBoardThumb } from "../store/cacheDb";
import {
  THUMB_MAX_EDGE,
  THUMB_MIME,
  THUMB_QUALITY,
  liveElements,
  shouldCapture,
  thumbSignature,
} from "./thumbPolicy";

/**
 * 缩略图取景：无限画布没有固定画板范围，用**进入白板时的可视区域**当取景框，
 * 再按卡片的 16:10 居中扩一圈（可见区域永远完整落在框内）。
 * 这样内容少时不会被放大、内容只占一角时也能看出它在画布里的位置和留白；
 * 所有板都用默认视口（scroll 0 / zoom 1），构图保持一致。
 */
const THUMB_RATIO = 16 / 10;
const THUMB_WIDTH = THUMB_MAX_EDGE;
const THUMB_HEIGHT = Math.round(THUMB_MAX_EDGE / THUMB_RATIO);

type ThumbFrame = { x: number; y: number; width: number; height: number };

/** 每块板只在本次会话里定一次取景框，之后编辑重拍沿用同一个构图 */
const thumbFrames = new Map<string, ThumbFrame>();

function frameFromViewport(api: ExcalidrawImperativeAPI): ThumbFrame | null {
  const state = api.getAppState();
  const zoom = state.zoom?.value || 1;
  let width = state.width / zoom;
  let height = state.height / zoom;
  if (!(width > 0) || !(height > 0)) return null;
  let x = -state.scrollX;
  let y = -state.scrollY;
  if (width / height > THUMB_RATIO) {
    const next = width / THUMB_RATIO;
    y -= (next - height) / 2;
    height = next;
  } else if (width / height < THUMB_RATIO) {
    const next = height * THUMB_RATIO;
    x -= (next - width) / 2;
    width = next;
  }
  return { x, y, width, height };
}

function thumbFrameFor(api: ExcalidrawImperativeAPI, boardId: string): ThumbFrame | null {
  const cached = thumbFrames.get(boardId);
  if (cached) return cached;
  const frame = frameFromViewport(api);
  if (frame) thumbFrames.set(boardId, frame);
  return frame;
}

/**
 * 首帧快照链路（前端 IndexedDB `wb-cache` / `thumbs` store）。
 *
 * 写入时机：画布 API 就绪、缓存/快照元素已灌入之后，等字体与两帧渲染完成，
 * 再在空闲回调里导出。此时看到的就是"进板第一眼"的画面。
 *
 * 跳过条件：同一块板已有快照且内容指纹一致 → 直接返回，反复进出不重拍。
 * 失败回退：导出/写盘任何一步失败都只打日志，卡片继续用线稿占位，不影响画布。
 *
 * 服务端副本：离开白板时把这里写好的 Blob 上传一次（`PUT /api/boards/:id/thumbnail`），
 * 列表页优先用 `boards.thumbnail_url`，跨设备也能看到卡片图；上传失败仍回退本机副本。
 */
export function scheduleThumbCapture(
  api: ExcalidrawImperativeAPI,
  owner: string,
  boardId: string,
  options: { fast?: boolean } = {},
): void {
  // 尽量在进板这一刻就把视口定下来，后续的编辑重拍不再跟随用户平移/缩放
  const frameKey = `${owner}:${boardId}`;
  thumbFrameFor(api, frameKey);
  const run = () => {
    void (async () => {
      try {
        await document.fonts?.ready;
      } catch {
        /* 字体接口不可用就直接拍 */
      }
      // 连续两帧：第一帧等 updateScene 落到画布，第二帧等浏览器完成绘制
      requestAnimationFrame(() => {
        requestAnimationFrame(() => void captureBoardThumb(api, owner, boardId));
      });
    })();
  };

  // 编辑后的重拍要赶在用户点「返回」之前写完，不能再等空闲回调；
  // 首帧快照仍走 idle，避免和进板渲染抢主线程。
  if (!options.fast && typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(run, { timeout: 1500 });
  } else {
    run();
  }
}

export async function captureBoardThumb(
  api: ExcalidrawImperativeAPI,
  owner: string,
  boardId: string,
): Promise<void> {
  const key = `${owner}:${boardId}`;
  // 同一块板的拍摄串行化：并发导出时后完成的旧画面可能覆盖新画面
  const previous = thumbQueue.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => captureBoardThumbNow(api, owner, boardId, key));
  thumbQueue.set(key, next);
  await next;
}

const thumbQueue = new Map<string, Promise<void>>();

/**
 * 最近一次拍好的 Blob 在内存里留一份：`pagehide` 阶段 IndexedDB 的异步读取
 * 大概率来不及跑完（文档卸载会打断事务），上传兜底必须能在事件里**同步**拿到字节。
 */
const thumbMemory = new Map<string, Blob>();

/** 同步取本次会话已拍好的缩略图；没有则 `null`（调用方再走异步拍摄/读盘）。 */
export function peekBoardThumb(owner: string, boardId: string): Blob | null {
  return thumbMemory.get(`${owner}:${boardId}`) ?? null;
}

async function captureBoardThumbNow(
  api: ExcalidrawImperativeAPI,
  owner: string,
  boardId: string,
  frameKey: string,
): Promise<void> {
  try {
    const elements = api.getSceneElements();
    const signature = thumbSignature(elements);
    if (!signature) {
      // 画面已清空：删掉内存与本地持久化副本，卡片退回线稿占位。
      // 不删的话列表会一直展示"清空前"的老图（空板指纹为空，后面的拍摄都会被跳过）。
      thumbMemory.delete(frameKey);
      const stale = await readBoardThumb(owner, boardId).catch(() => null);
      if (stale) await deleteBoardThumb(owner, boardId).catch(() => undefined);
      return;
    }

    const previous = await readBoardThumb(owner, boardId).catch(() => null);
    if (!shouldCapture(previous, signature)) return;

    const frame = thumbFrameFor(api, frameKey);
    if (!frame) return;

    const live = liveElements(elements) as never;
    // 导出 SVG 后把 viewBox 换成画布取景框：元素保持场景坐标，
    // 框外的部分自然被裁掉，框内的留白和相对位置原样保留。
    const svg = await exportToSvg({
      elements: live,
      files: api.getFiles(),
      appState: {
        ...api.getAppState(),
        exportBackground: true,
        exportWithDarkMode: false,
        viewBackgroundColor: "#ffffff",
      },
      exportPadding: 0,
    });
    // exportToSvg 把元素整体平移到内容包围盒原点（offset = -min + padding，padding 传 0），
    // 所以它的 viewBox 永远是 `0 0 内容宽 内容高`，不能直接当场景坐标用。
    // 取景框是场景坐标，换 viewBox 时要减掉这个平移量，否则画面会整体偏到左上角。
    const [minX = 0, minY = 0] = getCommonBounds(live);
    svg.setAttribute("viewBox", `${frame.x - minX} ${frame.y - minY} ${frame.width} ${frame.height}`);
    svg.setAttribute("width", `${THUMB_WIDTH}`);
    svg.setAttribute("height", `${THUMB_HEIGHT}`);
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

    const blob = await rasterize(svg);
    if (!(blob instanceof Blob) || blob.size === 0) return;
    await writeBoardThumb({ owner, boardId, blob, signature });
    thumbMemory.set(frameKey, blob);
  } catch (err) {
    console.warn("[boards] 首帧缩略图失败，卡片回退线稿占位", err);
  }
}

/** SVG → 640×400 白底 WebP：比例固定 16:10，不随内容多少变形 */
async function rasterize(svg: SVGSVGElement): Promise<Blob | null> {
  const xml = new XMLSerializer().serializeToString(svg);
  const url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = THUMB_WIDTH;
    canvas.height = THUMB_HEIGHT;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, THUMB_WIDTH, THUMB_HEIGHT);
    context.drawImage(image, 0, 0, THUMB_WIDTH, THUMB_HEIGHT);
    return await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, THUMB_MIME, THUMB_QUALITY);
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 列表页一次性取出当前身份的缩略图并转成可直接给 <img> 用的 objectURL。 */
export async function loadThumbUrls(owner: string): Promise<Record<string, string>> {
  const records = await readAllBoardThumbs(owner);
  const urls: Record<string, string> = {};
  for (const [boardId, record] of records) {
    if (!(record.blob instanceof Blob) || record.blob.size === 0) continue;
    urls[boardId] = URL.createObjectURL(record.blob);
  }
  return urls;
}
