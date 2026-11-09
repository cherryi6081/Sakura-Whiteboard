import { useCallback, useEffect, useRef } from "react";
import { CaptureUpdateAction, Excalidraw } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ElementOp } from "@whiteboard/shared";
import type { AssetInfo } from "./assetApi";
import { AssetApiError, fetchAssetAsDataUrl } from "./assetApi";
import { createOpBatcher, createOpDeriver } from "../collab/deriveOps";

/** 画布内的中性配置：白底、新建元素默认描边为品牌色（视觉方案 §5.2）。网格默认关闭，不设 gridSize。 */
const CANVAS_INITIAL_DATA = {
  appState: {
    viewBackgroundColor: "#ffffff",
    currentItemStrokeColor: "#a85c7c",
  },
};

/** 图片落画布时的最大显示尺寸（超出按比例缩小，不放大） */
const MAX_IMAGE_W = 720;
const MAX_IMAGE_H = 540;

export type BoardCanvasHandle = {
  getElements: () => readonly any[];
  /**
   * 远端回放：先把派生基线重置成这份元素，再 `updateScene(NEVER)`。
   * 基线同步保证 `onChange` 不会把远端改动当成新 op 再发回去；
   * 另外 `updateScene` 可能触发一次内部规范化，因此吞掉紧随其后的那一帧 onChange，
   * 只把它当作新的基线（避免把远端回放"回声"成 op）。
   */
  applyRemoteElements: (elements: readonly any[]) => void;
  /**
   * 插入一张已上传完成的图片（v1.1）。调用前必须已经拿到 dataURL，
   * 这样 `addFiles` 与元素同帧生效，不会出现"元素有了但文件没有"的闪烁。
   * `point` 是视口坐标（拖拽/按钮用），不传则落在视口中心。
   */
  insertImage: (asset: Pick<AssetInfo, "id" | "width" | "height" | "mime">, dataUrl: string, point?: { clientX: number; clientY: number } | null) => void;
};

type Props = {
  initialElements: readonly any[];
  viewModeEnabled?: boolean;
  /** 分享 token：拉取图片字节时用于通过权限判定 */
  shareToken?: string | null;
  onApiReady?: (api: ExcalidrawImperativeAPI, handle: BoardCanvasHandle) => void;
  /** 一批合并后的元素级 op */
  onOps?: (ops: ElementOp[]) => void;
};

let nonceSeed = 0;
const nextNonce = () => {
  nonceSeed = (nonceSeed + 1) % 1_000_000;
  return Math.floor(Math.random() * 1_000_000_000) + nonceSeed;
};

const elementId = () =>
  typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `img_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

/**
 * 渲染与派生解耦：本组件只负责把 `onChange` 的全量数组交给 `deriveOps`，
 * 再由 50ms 静默 flush（或 pointerup 立即 flush）交出批量 op。
 *
 * v1.1 起承担图片的"文件侧"：本地插入时先 `addFiles` 再 `updateScene`；
 * 远端/快照里的图片元素只带 `fileId`（= assetId），由这里按签名 URL 拉回字节补进 `addFiles`，
 * 元素先到、字节后到时会有背压重试，不会留下永久破图。
 */
export function BoardCanvas({ initialElements, viewModeEnabled, shareToken, onApiReady, onOps }: Props) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const deriverRef = useRef(createOpDeriver());
  const onOpsRef = useRef(onOps);
  onOpsRef.current = onOps;
  const shareTokenRef = useRef(shareToken);
  shareTokenRef.current = shareToken;
  const batcherRef = useRef(
    createOpBatcher({
      onFlush: (ops) => onOpsRef.current?.(ops),
    }),
  );
  /** 远端回放触发的下一帧 onChange 只同步基线，不产出 op */
  const suppressDeriveRef = useRef(0);
  const suppressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 正在拉取字节的 fileId，避免同一张图并发重复请求 */
  const loadingFilesRef = useRef(new Set<string>());

  /** 把场景里缺字节的图片元素补齐；元素先到/字节慢到都靠这里收敛。 */
  const ensureImageFiles = useCallback((api: ExcalidrawImperativeAPI, delayMs = 0) => {
    const run = () => {
      if (apiRef.current !== api) return;
      const files = api.getFiles() as Record<string, unknown>;
      const images = api.getSceneElements().filter((el) => el.type === "image" && !el.isDeleted);
      for (const element of images) {
        const fileId = (element as { fileId?: string }).fileId;
        if (!fileId || files[fileId] || loadingFilesRef.current.has(fileId)) continue;
        loadingFilesRef.current.add(fileId);
        void loadOneFile(api, fileId, shareTokenRef.current)
          .catch((err) => {
            // 失败只影响这一张图；不抛到画布，不阻塞其他操作
            console.warn("[asset] 图片文件加载失败", fileId, err);
          })
          .finally(() => loadingFilesRef.current.delete(fileId));
      }
    };

    if (delayMs > 0) {
      setTimeout(run, delayMs);
    } else {
      run();
    }
  }, []);

  const handle: BoardCanvasHandle = {
    getElements: () => apiRef.current?.getSceneElements() ?? [],
    applyRemoteElements: (elements) => {
      suppressDeriveRef.current += 1;
      if (suppressTimerRef.current !== null) clearTimeout(suppressTimerRef.current);
      // 兜底：极端情况下 updateScene 没有触发 onChange，别把后续用户改动一起吞掉
      suppressTimerRef.current = setTimeout(() => {
        suppressTimerRef.current = null;
        suppressDeriveRef.current = 0;
      }, 200);
      deriverRef.current.reset(elements as any);
      apiRef.current?.updateScene({
        elements: elements as any,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      if (apiRef.current) ensureImageFiles(apiRef.current, 20);
    },
    insertImage: (asset, dataUrl, point) => {
      const api = apiRef.current;
      if (!api) return;

      const scale = Math.min(1, MAX_IMAGE_W / Math.max(1, asset.width), MAX_IMAGE_H / Math.max(1, asset.height));
      const width = Math.max(1, Math.round(asset.width * scale));
      const height = Math.max(1, Math.round(asset.height * scale));

      const state = api.getAppState();
      const rect = containerRef.current?.getBoundingClientRect();
      const zoom = state.zoom.value || 1;
      let x: number;
      let y: number;
      if (point && rect) {
        x = (point.clientX - rect.left) / zoom - state.scrollX;
        y = (point.clientY - rect.top) / zoom - state.scrollY;
      } else {
        const viewW = rect?.width ?? 0;
        const viewH = rect?.height ?? 0;
        x = viewW / 2 / zoom - state.scrollX;
        y = viewH / 2 / zoom - state.scrollY;
      }

      const element = {
        id: elementId(),
        type: "image",
        x: Math.round(x - width / 2),
        y: Math.round(y - height / 2),
        width,
        height,
        angle: 0,
        strokeColor: "transparent",
        backgroundColor: "transparent",
        fillStyle: "solid",
        strokeWidth: 0,
        strokeStyle: "solid",
        roughness: 0,
        opacity: 100,
        roundness: null,
        seed: nextNonce(),
        version: 1,
        versionNonce: nextNonce(),
        index: null,
        isDeleted: false,
        groupIds: [],
        frameId: null,
        boundElements: null,
        updated: Date.now(),
        link: null,
        locked: false,
        customData: { assetId: asset.id },
        fileId: asset.id,
        status: "saved",
        scale: [1, 1],
        crop: null,
      };

      // 先补文件再放元素：同帧渲染，避免出现一帧"缺图"
      api.addFiles([
        {
          id: asset.id,
          mimeType: asset.mime,
          dataURL: dataUrl,
          created: Date.now(),
          lastRetrieved: Date.now(),
          version: 1,
        } as any,
      ]);
      api.updateScene({
        elements: [...api.getSceneElements(), element as any],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    },
  };

  /**
   * 注意：**不要**把缓存元素塞进 `initialData`。
   * Excalidraw 对 `initialData` 会走 restore 路径（会升级元素版本），
   * 导致首次 onChange 与缓存里的 element 版本不一致，被派生层当成"用户改动"回传，
   * 多端之间形成 op 回声循环。这里先挂空画布，API 就绪后再用 updateScene 无损灌入。
   */
  useEffect(
    () => () => {
      if (suppressTimerRef.current !== null) clearTimeout(suppressTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    const flush = () => batcherRef.current.flushNow();
    window.addEventListener("pointerup", flush);
    window.addEventListener("pointercancel", flush);
    window.addEventListener("blur", flush);
    return () => {
      window.removeEventListener("pointerup", flush);
      window.removeEventListener("pointercancel", flush);
      window.removeEventListener("blur", flush);
      batcherRef.current.dispose();
    };
  }, []);

  return (
    <div ref={containerRef} style={{ height: "100%", width: "100%" }}>
      <Excalidraw
        excalidrawAPI={(api) => {
          apiRef.current = api;
          // Excalidraw 刚挂载时还会初始化场景；下一拍再把缓存/快照灌入，
          // 否则 updateScene 会被后续初始化覆盖（表现为刷新后画布空白，直到补拉回来）。
          setTimeout(() => {
            if (apiRef.current !== api) return;
            handle.applyRemoteElements(initialElements);
            onApiReady?.(api, handle);
          }, 0);
        }}
        initialData={CANVAS_INITIAL_DATA}
        viewModeEnabled={viewModeEnabled ?? false}
        // 内置 image 工具走"本地 base64 + 元素"路径，协作者拿不到字节；统一收口到自研上传入口
        UIOptions={{ tools: { image: false } }}
        onChange={(elements) => {
          if (suppressDeriveRef.current > 0) {
            // 这一帧来自远端回放/初始灌入：只把实际场景当作新基线
            suppressDeriveRef.current -= 1;
            if (suppressTimerRef.current !== null) {
              clearTimeout(suppressTimerRef.current);
              suppressTimerRef.current = null;
            }
            deriverRef.current.reset(elements as any);
            return;
          }
          const ops = deriverRef.current.derive(elements as any);
          batcherRef.current.push(ops);
        }}
      />
    </div>
  );
}

/**
 * 拉回一张图片的字节并塞进 `addFiles`。
 * "元素已同步但附件还没传完"的时序：403/404/5xx 都按退避重试，最多 4 次；
 * 4 次仍失败只放弃这一张（元素保留，刷新页面会再次尝试），不会卡住画布。
 */
async function loadOneFile(api: ExcalidrawImperativeAPI, assetId: string, shareToken: string | null | undefined): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (api.getFiles()[assetId]) return;
    try {
      const { dataUrl, mime } = await fetchAssetAsDataUrl(assetId, shareToken);
      api.addFiles([
        {
          id: assetId,
          mimeType: mime,
          dataURL: dataUrl,
          created: Date.now(),
          lastRetrieved: Date.now(),
          version: 1,
        } as any,
      ]);
      return;
    } catch (err) {
      lastError = err;
      const retriable = err instanceof AssetApiError ? err.retriable || err.status === 404 : true;
      if (!retriable) break;
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
  throw lastError;
}
