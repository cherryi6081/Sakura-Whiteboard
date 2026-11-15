import { describe, expect, it } from "vitest";
import { AUTO_SCROLL_EDGE, AUTO_SCROLL_MAX_STEP, edgeScrollStep } from "./autoScroll";

describe("edgeScrollStep", () => {
  const top = 0;
  const bottom = 950;

  it("视口中部不滚动", () => {
    expect(edgeScrollStep(475, top, bottom)).toBe(0);
    expect(edgeScrollStep(64, top, bottom)).toBe(0);
    expect(edgeScrollStep(950 - 64, top, bottom)).toBe(0);
  });

  it("靠近顶边向上滚，越近越快，压到边缘保持最大速度", () => {
    const far = edgeScrollStep(63, top, bottom);
    const near = edgeScrollStep(20, top, bottom);
    const edge = edgeScrollStep(0, top, bottom);
    expect(far).toBeLessThan(0);
    expect(Math.abs(near)).toBeGreaterThan(Math.abs(far));
    expect(edge).toBe(-AUTO_SCROLL_MAX_STEP);
    expect(edgeScrollStep(1, top, bottom)).toBe(-AUTO_SCROLL_MAX_STEP);
  });

  it("靠近底边向下滚，越近越快，压到边缘保持最大速度", () => {
    const far = edgeScrollStep(bottom - 63, top, bottom);
    const near = edgeScrollStep(bottom - 20, top, bottom);
    expect(far).toBeGreaterThan(0);
    expect(near).toBeGreaterThan(far);
    expect(edgeScrollStep(bottom, top, bottom)).toBe(AUTO_SCROLL_MAX_STEP);
    expect(edgeScrollStep(bottom - 1, top, bottom)).toBe(AUTO_SCROLL_MAX_STEP);
  });

  it("进入边缘时速度至少 1px，不会因取整而没反应", () => {
    expect(edgeScrollStep(AUTO_SCROLL_EDGE - 1, top, bottom)).not.toBe(0);
    expect(edgeScrollStep(bottom - AUTO_SCROLL_EDGE + 1, top, bottom)).toBeGreaterThan(0);
  });

  it("指针移出可视区返回 0（调用方停止 rAF）", () => {
    expect(edgeScrollStep(-1, top, bottom)).toBe(0);
    expect(edgeScrollStep(bottom + 1, top, bottom)).toBe(0);
    expect(edgeScrollStep(Number.NaN, top, bottom)).toBe(0);
  });

  it("可自定义边缘距离与最大速度", () => {
    expect(edgeScrollStep(10, top, bottom, 100, 30)).toBe(-27);
    // 90 仍在 100px 边缘区内（离底边还很远），加速比 0.1 → 3px
    expect(edgeScrollStep(90, top, bottom, 100, 30)).toBe(-3);
    expect(edgeScrollStep(200, top, bottom, 100, 30)).toBe(0);
  });

  it("滚动区域非法（高度为 0）时不滚", () => {
    expect(edgeScrollStep(0, 0, 0)).toBe(0);
  });
});
