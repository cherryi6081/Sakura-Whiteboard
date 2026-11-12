/**
 * 首帧缩略图规则（纯函数）：拍多大、什么时候拍、怎么判断要不要重拍。
 * 与 IndexedDB / Excalidraw 解耦，便于在 Node 里单测。
 *
 * - 尺寸：最长边 640px（卡片缩略图约 320–337 CSS px，2x 屏正好一档），
 *   WebP q0.8，常见板书 8–30KB，远小于 wb-cache 里已有的元素缓存。
 * - 重拍判定：元素数量 + 版本号之和 + 最大 updated 组成的指纹；
 *   任何元素被增删改，Excalidraw 都会抬高 version/updated，指纹随之变化。
 * - 空板不拍：没有可看的板书，卡片继续用线稿占位，避免存一张纯白图。
 */

export const THUMB_MAX_EDGE = 640;
export const THUMB_MIME = "image/webp";
export const THUMB_QUALITY = 0.8;

export type ThumbElement = {
  id?: string;
  version?: number;
  updated?: number;
  isDeleted?: boolean;
};

export function liveElements<T extends ThumbElement>(elements: readonly T[]): T[] {
  return elements.filter((element) => element.isDeleted !== true);
}

export function thumbSignature(elements: readonly ThumbElement[]): string {
  const live = liveElements(elements);
  if (live.length === 0) return "";

  let versionSum = 0;
  let maxUpdated = 0;
  for (const element of live) {
    versionSum += Number.isFinite(element.version) ? Number(element.version) : 0;
    maxUpdated = Math.max(maxUpdated, Number.isFinite(element.updated) ? Number(element.updated) : 0);
  }
  return `${live.length}:${versionSum}:${maxUpdated}`;
}

/**
 * 已有快照且指纹一致 → 跳过（同一块板反复进出不重拍）；
 * 指纹变了（内容有改动）或还没有快照 → 拍。
 */
export function shouldCapture(
  previous: { signature: string } | null | undefined,
  signature: string,
): boolean {
  if (!signature) return false;
  if (!previous) return true;
  return previous.signature !== signature;
}
