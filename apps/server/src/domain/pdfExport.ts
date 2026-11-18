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
