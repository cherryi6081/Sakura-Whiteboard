import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { buildPdfFromPng, clampPdfScale, pdfPageSizeOf, PDF_SCALE_MAX, PDF_SCALE_MIN } from './pdfExport.js';

/** 真实可解析的 1×1 PNG（pdf-lib 需要完整 chunk，不能只造文件头） */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('clampPdfScale', () => {
  it('越界收敛到 1–4，非法值回落 1', () => {
    expect(clampPdfScale(0)).toBe(PDF_SCALE_MIN);
    expect(clampPdfScale(2)).toBe(2);
    expect(clampPdfScale(9)).toBe(PDF_SCALE_MAX);
    expect(clampPdfScale(Number.NaN)).toBe(PDF_SCALE_MIN);
  });
});

describe('pdfPageSizeOf', () => {
  it('96 CSS px = 72pt，并按渲染倍率还原逻辑尺寸', () => {
    expect(pdfPageSizeOf(800, 600, 1)).toEqual({ width: 600, height: 450 });
    expect(pdfPageSizeOf(1600, 1200, 2)).toEqual({ width: 600, height: 450 });
  });

  it('超过 PDF 单页上限时整体等比缩小', () => {
    const size = pdfPageSizeOf(100_000, 10_000, 1);
    expect(size.width).toBeCloseTo(14400, 5);
    expect(size.height).toBeCloseTo(1440, 5);
  });
});

describe('buildPdfFromPng', () => {
  it('生成单页 PDF，页面尺寸与图片逻辑尺寸一致', async () => {
    const bytes = await buildPdfFromPng(PNG_1X1, 1);
    expect(Buffer.from(bytes).subarray(0, 5).toString('ascii')).toBe('%PDF-');

    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(1);
    const page = pdf.getPage(0);
    expect(page.getWidth()).toBeCloseTo(0.75, 3);
    expect(page.getHeight()).toBeCloseTo(0.75, 3);
    expect(page.node.Resources()).toBeDefined();
  });

  it('无法解析的 PNG 直接抛错，交给路由收敛成客户端错误', async () => {
    await expect(buildPdfFromPng(Buffer.from('not a png'), 2)).rejects.toThrow();
  });
});
