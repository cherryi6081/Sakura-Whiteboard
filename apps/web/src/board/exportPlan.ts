/**
 * 导出用纯函数（不依赖 Excalidraw 运行时，便于单测）。
 *
 * 口径：整张画布、白底、文件名 `<板名>-<yyyyMMdd-HHmm>.png|svg`。
 */

export type ExportFormat = "png" | "svg";

/** Windows / macOS / Linux 都不接受的文件名字符（控制字符单独按范围处理） */
const UNSAFE_FILENAME = /[\\/:*?"<>|\u0000-\u001f]/g;
const MAX_TITLE_LENGTH = 60;
/** 导出留白：整张画布四周统一 16px，避免内容贴边 */
export const EXPORT_PADDING = 16;
export const FALLBACK_TITLE = "白板";

/** 把板名收敛成可用的文件名片段：非法字符换 `-`、压缩空白、去掉开头的点、限长 */
export function sanitizeExportTitle(title: string): string {
  const cleaned = title
    .replace(UNSAFE_FILENAME, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  const limited = cleaned.slice(0, MAX_TITLE_LENGTH).trim();
  return limited || FALLBACK_TITLE;
}

/** 本地时间的 `yyyyMMdd-HHmm`，精确到分钟足够避免同板重复导出互相覆盖 */
export function exportStamp(date: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours(),
  )}${pad(date.getMinutes())}`;
}

export function buildExportFileName(
  title: string,
  format: ExportFormat,
  date: Date = new Date(),
): string {
  return `${sanitizeExportTitle(title)}-${exportStamp(date)}.${format}`;
}

/** 导出只含未删除元素：画布上的「已删除」由库在视图层过滤，导出函数也不接受它们 */
export function liveSceneElements(elements: readonly any[]): any[] {
  return elements.filter((element) => element && !element.isDeleted);
}

/** 板内所有图片元素引用的 fileId（去重，保持出现顺序） */
export function imageFileIds(elements: readonly any[]): string[] {
  const ids: string[] = [];
  for (const element of elements) {
    if (element?.type !== "image" || typeof element.fileId !== "string") continue;
    if (!ids.includes(element.fileId)) ids.push(element.fileId);
  }
  return ids;
}

/** 板内图片里、当前 `files` 还没有字节的那些 fileId */
export function missingImageFileIds(
  elements: readonly any[],
  files: Record<string, unknown> | null | undefined,
): string[] {
  return imageFileIds(elements).filter((id) => !files?.[id]);
}

/** 导出用的 appState：强制白底、不暗色、不嵌入场景（嵌入会让文件体积翻倍且无必要） */
export function exportAppStateOf(appState: Record<string, any>): Record<string, any> {
  return {
    ...appState,
    exportBackground: true,
    viewBackgroundColor: "#ffffff",
    exportWithDarkMode: false,
    exportEmbedScene: false,
    exportScale: appState.exportScale ?? 1,
  };
}
