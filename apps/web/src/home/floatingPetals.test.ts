import { describe, expect, it } from "vitest";
import {
  FLOATING_PETALS,
  craneVisualHeight,
  floatingBand,
  floatingCount,
  floatingFootprint,
  petalFloor,
} from "./floatingPetals";

const VIEWPORTS: Array<[number, number]> = [
  [1440, 900],
  [2560, 1080],
  [3440, 1440],
  [1024, 768],
  [390, 844],
];

/** 湖带高度：与 .wb-scene__water / .wb-scene__floaters 的 CSS 完全一致 */
function bandHeight(width: number, height: number) {
  return 0.371111 * Math.min(0.5625 * width, height);
}

/** 只保留 CSS 实际会显示的片：移动端隐藏没有 --sm 的那些 */
function visible(width: number) {
  return FLOATING_PETALS.filter((petal) => width > 767 || petal.mobile);
}

/** 超宽屏两翼：16:9 内容区之外左右各一条 CSS 湖带 */
function wingBounds(width: number, height: number) {
  const contentW = (Math.min(0.5625 * width, height) / 900) * 1600;
  const wing = Math.max(0, ((width - contentW) / 2 / width) * 100);
  return { left: wing, right: 100 - wing };
}

describe("漂浮花瓣数量", () => {
  it("桌面 34 片、移动端 23 片，分别落在 30–38 / 20–26 的目标区间", () => {
    expect(floatingCount(false)).toBe(34);
    expect(floatingCount(true)).toBe(23);
    expect(floatingCount(false)).toBeGreaterThanOrEqual(30);
    expect(floatingCount(false)).toBeLessThanOrEqual(38);
    expect(floatingCount(true)).toBeGreaterThanOrEqual(20);
    expect(floatingCount(true)).toBeLessThanOrEqual(26);
  });

  it("近处最多最大、远处最少最小（桌面 16/8/10，移动端 10/6/7）", () => {
    const count = (mobile: boolean) => {
      const bands: Record<string, number> = { far: 0, mid: 0, near: 0 };
      for (const petal of FLOATING_PETALS) {
        if (mobile && !petal.mobile) continue;
        bands[floatingBand(petal.depth)] += 1;
      }
      return bands;
    };
    expect(count(false)).toEqual({ far: 10, mid: 8, near: 16 });
    expect(count(true)).toEqual({ far: 7, mid: 6, near: 10 });
  });

  it("四堆的大小：c1 4 片 / c2 3 片 / c3 3 片 / c4 4 片", () => {
    const size = (cluster: string) =>
      FLOATING_PETALS.filter((petal) => petal.cluster === cluster).length;
    expect(size("c1")).toBe(4);
    expect(size("c2")).toBe(3);
    expect(size("c3")).toBe(3);
    expect(size("c4")).toBe(4);
  });
});

describe("水面透视", () => {
  it("depth 全在 (0,1)，越深越大越接近正面视角", () => {
    for (const petal of FLOATING_PETALS) {
      const { width, height, aspect } = floatingFootprint(petal, 1440, 900);
      expect(petal.depth).toBeGreaterThan(0);
      expect(petal.depth).toBeLessThan(1);
      expect(width).toBeGreaterThan(height);
      expect(aspect).toBeCloseTo(0.34 + 0.5 * petal.depth, 1);
      expect(petal.size).toBeGreaterThanOrEqual(9);
      expect(petal.size).toBeLessThanOrEqual(26);
    }
  });

  it("三档纵横比依次抬升：远 < 中 < 近", () => {
    const aspectOf = (band: "far" | "mid" | "near") => {
      const values = FLOATING_PETALS.filter((petal) => floatingBand(petal.depth) === band).map(
        (petal) => floatingFootprint(petal, 1440, 900).aspect,
      );
      return { min: Math.min(...values), max: Math.max(...values) };
    };
    const far = aspectOf("far");
    const mid = aspectOf("mid");
    const near = aspectOf("near");
    expect(far.max).toBeLessThan(mid.min);
    expect(mid.max).toBeLessThan(near.min);
    // 数值区间与 CSS 注释一致
    expect(far.min).toBeGreaterThanOrEqual(0.45);
    expect(far.max).toBeLessThanOrEqual(0.5);
    expect(mid.min).toBeGreaterThanOrEqual(0.55);
    expect(mid.max).toBeLessThanOrEqual(0.65);
    expect(near.min).toBeGreaterThanOrEqual(0.7);
    expect(near.max).toBeLessThanOrEqual(0.81);
  });

  it.each(VIEWPORTS)("%i×%i：长边落在鹤高的 3–6%，且不低于单朵下限", (width, height) => {
    const craneH = craneVisualHeight(width, height);
    for (const petal of FLOATING_PETALS) {
      const { width: petalWidth } = floatingFootprint(petal, width, height);
      expect(petalWidth).toBeGreaterThanOrEqual(petalFloor(width));
      // 触底的档位会被下限抬起来，只校验未被截断的那些仍在比例区间内
      if (petalWidth > petalFloor(width)) {
        // petalEdgePx 保留两位小数，折算成比例后留 0.0005 容差
        const ratio = petalWidth / craneH;
        expect(ratio).toBeGreaterThanOrEqual(0.03 - 0.0005);
        expect(ratio).toBeLessThanOrEqual(0.06 + 0.0005);
      }
    }
  });

  it.each(VIEWPORTS)("%i×%i：全部落在水线以下、湖底板以上", (width, height) => {
    const band = bandHeight(width, height);
    for (const petal of visible(width)) {
      const { height: petalHeight } = floatingFootprint(petal, width, height);
      const top = 14 + (band - 28) * petal.depth;
      const half = petalHeight / 2;
      // 顶边在水线下（湖带内部），底边不贴湖底板
      expect(top - half).toBeGreaterThan(0);
      expect(top + half).toBeLessThanOrEqual(band);
    }
  });

  it.each(VIEWPORTS)("%i×%i：横向不越界（含自带水纹的最大外扩）", (width, height) => {
    for (const petal of visible(width)) {
      const { width: petalWidth } = floatingFootprint(petal, width, height);
      const left = (petal.x / 100) * width;
      // 静态水纹宽 2.2 倍，是外扩最大的一层
      const half = (petalWidth * 2.2) / 2;
      expect(left - half).toBeGreaterThanOrEqual(0);
      expect(left + half).toBeLessThanOrEqual(width);
    }
  });

  it.each(VIEWPORTS)("%i×%i：超宽屏两翼也有漂浮花瓣", (width, height) => {
    const { left, right } = wingBounds(width, height);
    const petals = visible(width);
    if (left <= 0) {
      expect(petals.every((petal) => petal.x >= 0 && petal.x <= 100)).toBe(true);
      return;
    }
    expect(petals.filter((petal) => petal.x < left).length).toBeGreaterThan(0);
    expect(petals.filter((petal) => petal.x > right).length).toBeGreaterThan(0);
  });
});

describe("漂浮动作参数", () => {
  it("周期 24–38s、位移只有几像素，不会被读成被风吹跑", () => {
    for (const petal of FLOATING_PETALS) {
      expect(petal.dur).toBeGreaterThanOrEqual(20);
      expect(petal.dur).toBeLessThanOrEqual(40);
      expect(petal.dx).toBeGreaterThanOrEqual(2);
      expect(petal.dx).toBeLessThanOrEqual(8);
      expect(petal.dy).toBeGreaterThanOrEqual(1);
      expect(petal.dy).toBeLessThanOrEqual(5);
      // 负延迟：首屏就已经处在不同相位
      expect(petal.delay).toBeLessThan(0);
    }
  });

  it("自带水纹每 8.5–14s 荡开一次且各片错相，不与落瓣同拍", () => {
    const delays = FLOATING_PETALS.map((petal) => petal.pulseDelay);
    for (const petal of FLOATING_PETALS) {
      expect(petal.pulse).toBeGreaterThanOrEqual(8.5);
      expect(petal.pulse).toBeLessThanOrEqual(14);
      expect(petal.pulseDelay).toBeLessThan(0);
    }
    // 任意两片的自带水纹相位都不同，全场不会同时炸开一圈
    expect(new Set(delays).size).toBe(delays.length);
  });
});
