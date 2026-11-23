import { PDFDocument } from 'pdf-lib';

/**
 * PNG → 单页 PDF（服务端导出，v1.1 补充项）。
 *
 * 为什么是「客户端先出 PNG、服务端再封 PDF」：
 * Excalidraw 的取景与渲染依赖 DOM/Canvas，纯 Node 环境没有可用的无头浏览器时不具备
 * 直接渲染场景的能力；而拉一个 Chromium 体积大、镜像还不稳定。这里复用客户端已经
 * 验证过的导出管线（整张画布 + 16px 留白），服务端只做 PDF 封装，不引入任何原生依赖。
 */

/** 96 CSS px = 1 inch = 72 PDF pt，保证导出页与屏幕尺寸成比例 */
const PT_PER_CSS_PX = 72 / 96;
/** PDF 规范单页边长上限（200 inch）；超长画布整体等比缩小，保持长宽比 */
const MAX_PAGE_PT = 14400;
export const PDF_SCALE_MIN = 1;
export const PDF_SCALE_MAX = 4;

/**
 * 单张导出 PNG 的像素上限（2400 万）。
 * pdf-lib 解码 PNG 时会先解出整张 RGBA 再拆通道，峰值与像素数成正比（实测约 12–16MiB/MP），
 * 因此必须在交给 pdf-lib 之前按 IHDR 宽高拦截；24MP 约对应 2 倍导出下 6000×4000 的逻辑画布。
 */
export const PDF_EXPORT_MAX_PIXELS = 24_000_000;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 只认 PNG 签名，不做完整解码 */
export function isPngSignature(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) return false;
  return PNG_SIGNATURE.every((value, index) => bytes[index] === value);
}

/**
 * 从 PNG 的 IHDR 直接读宽高，**不进入解码**。
 * 返回 null 表示头部非法 / 截断（签名对但 IHDR 缺失或长度为 0）。
 */
export function readPngPixelSizeOf(bytes: Uint8Array): { width: number; height: number } | null {
  // 8B 签名 + 4B 长度 + 4B 'IHDR' + 4B 宽 + 4B 高
  if (!isPngSignature(bytes) || bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13) return null;
  if (String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!) !== 'IHDR') return null;
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** 导出倍率来自查询参数，越界或非法值一律收敛到合法区间 */
export function clampPdfScale(scale: number): number {
  if (!Number.isFinite(scale)) return PDF_SCALE_MIN;
  return Math.min(PDF_SCALE_MAX, Math.max(PDF_SCALE_MIN, scale));
}

/** 像素尺寸 + 渲染倍率 → PDF 页面尺寸（pt）。倍率让同一逻辑尺寸在不同清晰度下保持同一页大小。 */
export function pdfPageSizeOf(
  widthPx: number,
  heightPx: number,
  scale: number,
): { width: number; height: number } {
  const safeScale = clampPdfScale(scale);
  const width = (widthPx / safeScale) * PT_PER_CSS_PX;
  const height = (heightPx / safeScale) * PT_PER_CSS_PX;
  const factor = Math.min(1, MAX_PAGE_PT / Math.max(width, height));
  return { width: width * factor, height: height * factor };
}

/**
 * 把一张 PNG 封成单页 PDF，页面尺寸按 `scale` 还原成逻辑尺寸。
 * PNG 带 alpha 时 pdf-lib 会写入 SMask，内容之外保持透明（阅读器默认铺白）。
 */
export async function buildPdfFromPng(png: Uint8Array, scale: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setProducer('Sakura Whiteboard');
  doc.setCreator('Sakura Whiteboard');

  const image = await doc.embedPng(png);
  const size = pdfPageSizeOf(image.width, image.height, scale);
  const page = doc.addPage([size.width, size.height]);
  page.drawImage(image, { x: 0, y: 0, width: size.width, height: size.height });

  return doc.save();
}
