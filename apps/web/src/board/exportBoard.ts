import { exportToBlob, exportToSvg } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { fetchAssetAsDataUrl } from "../canvas/assetApi";
import {
  EXPORT_PADDING,
  FALLBACK_TITLE,
  buildExportFileName,
  exportAppStateOf,
  liveSceneElements,
  missingImageFileIds,
  type ExportBackground,
  type ExportFormat,
} from "./exportPlan";

/**
 * 白板导出（§13.3）。
 *
 * 口径（产品已确认）：
 * - 范围：整张画布（内容包围盒），不是可视区域；
 * - 背景：默认白底；透明背景为可选项（PNG / SVG），不替换默认行为；
 * - 游客与只读成员同样可导出 PNG / SVG（纯客户端行为）；
 * - PDF 由客户端出 PNG、服务端封装（`POST /api/boards/:id/export/pdf`，仅所有者）；
 * - 库自带的 Export / SaveAsImage 菜单项已隐藏，统一从这个入口走。
 *
 * 文件名与取景等纯逻辑在 `exportPlan.ts`（可单测），这里只负责跑导出与下载。
 */

/** PDF 走服务端转换，请求体是 PNG 原始字节；与后端上限保持一致 */
const PDF_RASTER_SCALE = 2;

export type ExportOptions = {
  shareToken?: string | null;
  /** 只影响 PNG / SVG；PDF 页面始终白底（PDF 无页面级透明） */
  background?: ExportBackground;
  /** PDF 必填：服务端导出接口按板校验权限 */
  boardId?: string;
};

export type ExportOutcome =
  | { status: "ok"; fileName: string; /** 仍缺字节、导出可能少图的图片数 */ missingImages: number }
  | { status: "empty" }
  | { status: "failed" };

/**
 * 导出前补齐图片字节：远端图片可能是「元素先到、字节后到」，
 * 这里对缺失的 fileId 逐张补拉一次；单张失败不阻断导出，最后把仍缺的数量交回调用方提示。
 */
async function ensureImageFiles(
  api: ExcalidrawImperativeAPI,
  elements: readonly any[],
  shareToken: string | null | undefined,
): Promise<number> {
  const missing = missingImageFileIds(elements, api.getFiles());
  for (const assetId of missing) {
    try {
      const { dataUrl, mime } = await fetchAssetAsDataUrl(assetId, shareToken);
      api.addFiles([{ id: assetId, mimeType: mime, dataURL: dataUrl, created: Date.now() } as any]);
    } catch {
      // 缺图不阻断：导出照常进行，由调用方提示「部分图片未加载」
    }
  }
  return missingImageFileIds(elements, api.getFiles()).length;
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // 立即 revoke 在部分浏览器会打断下载，延迟释放即可
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * 客户端先按白底出 PNG（复用同一套取景与留白），再交给服务端封 PDF。
 * 倍率取 2 起步：服务端页面尺寸按倍率还原，因此清晰度提升不会改变页面大小。
 */
async function requestPdfBlob(params: {
  elements: readonly any[];
  files: ReturnType<ExcalidrawImperativeAPI["getFiles"]>;
  appState: Record<string, any>;
  boardId: string;
  shareToken?: string | null;
}): Promise<Blob> {
  const configured = Number(params.appState.exportScale);
  const scale = Math.min(3, Math.max(PDF_RASTER_SCALE, Number.isFinite(configured) ? configured : 1));

  const raster = await exportToBlob({
    elements: params.elements as never,
    appState: { ...exportAppStateOf(params.appState, "white"), exportScale: scale } as never,
    files: params.files,
    mimeType: "image/png",
    exportPadding: EXPORT_PADDING,
  });

  const response = await fetch(
    `/api/boards/${encodeURIComponent(params.boardId)}/export/pdf?scale=${scale}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "image/png",
        // 自定义头强制跨站请求走预检，与图片上传同一套 CSRF 口径
        "x-wb-export": "1",
        ...(params.shareToken ? { "x-share-token": params.shareToken } : {}),
      },
      body: raster,
      credentials: "include",
    },
  );
  if (!response.ok) throw new Error(`pdf export failed: HTTP ${response.status}`);
  return response.blob();
}

/**
 * 执行一次导出。空画布直接返回 `empty`，由 UI 提示，不生成一张空白图。
 * 失败统一收敛成 `failed`，不把底层异常抛到渲染层。
 */
export async function exportBoard(
  api: ExcalidrawImperativeAPI,
  title: string,
  format: ExportFormat,
  options: ExportOptions = {},
): Promise<ExportOutcome> {
  const elements = liveSceneElements(api.getSceneElements() as readonly any[]);
  if (elements.length === 0) return { status: "empty" };

  try {
    const missingImages = await ensureImageFiles(api, elements, options.shareToken);
    const appState = exportAppStateOf(
      api.getAppState() as unknown as Record<string, any>,
      options.background,
    );
    const files = api.getFiles();
    const fileName = buildExportFileName(title || FALLBACK_TITLE, format);

    if (format === "png") {
      const blob = await exportToBlob({
        elements: elements as never,
        appState: appState as never,
        files,
        mimeType: "image/png",
        exportPadding: EXPORT_PADDING,
      });
      downloadBlob(blob, fileName);
    } else if (format === "svg") {
      const svg = await exportToSvg({
        elements: elements as never,
        appState: appState as never,
        files,
        exportPadding: EXPORT_PADDING,
      });
      downloadBlob(new Blob([svg.outerHTML], { type: "image/svg+xml;charset=utf-8" }), fileName);
    } else {
      if (!options.boardId) throw new Error("missing boardId for pdf export");
      const pdfBlob = await requestPdfBlob({
        elements,
        files,
        appState,
        boardId: options.boardId,
        shareToken: options.shareToken,
      });
      downloadBlob(pdfBlob, fileName);
    }
    return { status: "ok", fileName, missingImages };
  } catch (err) {
    console.warn("[board] 导出失败", err);
    return { status: "failed" };
  }
}
