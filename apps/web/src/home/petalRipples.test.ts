import { describe, expect, it } from "vitest";
import { LEFT_PETALS, PETALS, petalGeometry } from "./FujiScene";
import {
  INNER_PEAK_OPACITY,
  INNER_SPLASH_SECONDS,
  MAX_CONCURRENT_DESKTOP,
  MAX_CONCURRENT_MOBILE,
  MIN_RIPPLE_X_GAP,
  OUTER_PEAK_OPACITY,
  OUTER_SPLASH_SECONDS,
  countConcurrent,
  planRipples,
  splashFrames,
  timeAtDown,
  type PetalPath,
  type RippleInput,
} from "./petalRipples";

const PATHS: PetalPath[] = ["a", "b", "c", "d"];

/** 与 FujiScene 的 effect 完全一致的水线与倒影范围换算 */
function viewport(width: number, height: number) {
  const contentH = Math.min(0.5625 * width, height);
  const contentW = (contentH / 900) * 1600;
  const waterlinePct = ((height - 0.371111 * contentH) / height) * 100;
  const minX = Math.max(0, ((width - contentW) / 2 / width) * 100);
  return { waterlinePct, minX, maxX: 100 - minX, mobile: width <= 767, vh: height };
}

/** 组装涟漪输入，移动端按 pages.css 的 nth-child 收口过滤 */
function rippleInputs(mobile: boolean): RippleInput[] {
  const all = [...PETALS, ...LEFT_PETALS];
  const out: RippleInput[] = [];
  all.forEach((petal, key) => {
    const localIndex = key < PETALS.length ? key : key - PETALS.length;
    const limit = key < PETALS.length ? 12 : 5;
    if (mobile && localIndex >= limit) return;
    const geometry = petalGeometry(petal);
    out.push({
      key,
      left: petal.left,
      top: petal.top,
      dur: petal.dur,
      delay: petal.delay,
      size: petal.size,
      path: petal.path,
      sway: geometry.sway,
      fall: geometry.fall,
    });
  });
  return out;
}

const VIEWPORTS: Array<[number, number]> = [
  [1440, 900],
  [2560, 1080],
  [3440, 1440],
  [1024, 768],
  [390, 844],
];

describe("花瓣入水时刻", () => {
  it.each(PATHS)("%s：纵向进度 → 时间比例单调递增且首尾对齐", (path) => {
    let previous = -1;
    for (let step = 0; step <= 50; step++) {
      const time = timeAtDown(path, step / 50);
      expect(time).toBeGreaterThanOrEqual(previous);
      previous = time;
    }
    expect(timeAtDown(path, 0)).toBe(0);
    expect(timeAtDown(path, 1)).toBe(1);
  });

  it.each(PATHS)("%s：落在水线时，时间比例仍在周期内部", (path) => {
    for (const [width, height] of VIEWPORTS) {
      const { waterlinePct } = viewport(width, height);
      // 取中间高度的一片花瓣来验证
      const time = timeAtDown(path, (waterlinePct - -6) / (92 - -6));
      expect(time).toBeGreaterThan(0);
      expect(time).toBeLessThan(1);
    }
  });

  it("手机 390×844 的水线最靠下，入水时刻接近周期末尾但仍有效", () => {
    const { waterlinePct } = viewport(390, 844);
    expect(waterlinePct).toBeGreaterThan(90);
    expect(waterlinePct).toBeLessThan(92);
  });
});

describe("涟漪关键帧", () => {
  it("周期内只有入水点附近张开，offset 单调、首尾取值连续", () => {
    for (const path of PATHS) {
      for (const at of [0.35, 0.62, 0.83, 0.95, 0.99]) {
        const frames = splashFrames(at, 21, OUTER_SPLASH_SECONDS, OUTER_PEAK_OPACITY);
        expect(frames[0].offset).toBe(0);
        expect(frames[frames.length - 1].offset).toBe(1);
        for (let i = 1; i < frames.length; i++) {
          expect(frames[i].offset).toBeGreaterThan(frames[i - 1].offset);
        }
        // 循环回绕处 opacity / transform 必须相同，动画接续时不会跳一下
        expect(frames[0].opacity).toBe(frames[frames.length - 1].opacity);
        expect(frames[0].transform).toBe(frames[frames.length - 1].transform);
        // 每一片都必须真的有张开的一瞬
        expect(frames.some((frame) => frame.opacity > 0.05)).toBe(true);
        for (const frame of frames) expect(frame.opacity).toBeLessThanOrEqual(OUTER_PEAK_OPACITY);
      }
      expect(path).toMatch(/[abcd]/);
    }
  });

  it("两圈的时长与峰值都在“轻微”范围内", () => {
    for (const seconds of [OUTER_SPLASH_SECONDS, INNER_SPLASH_SECONDS]) {
      expect(seconds).toBeGreaterThanOrEqual(1.2);
      expect(seconds).toBeLessThanOrEqual(1.8);
    }
    expect(OUTER_PEAK_OPACITY).toBeLessThanOrEqual(0.35);
    expect(INNER_PEAK_OPACITY).toBeLessThanOrEqual(0.35);
  });
});

describe("涟漪落点与并发", () => {
  it.each(VIEWPORTS)("%i×%i：落点在水线以下水域、横向不越界、并发不超上限", (width, height) => {
    const { waterlinePct, minX, maxX, mobile } = viewport(width, height);
    const cap = mobile ? MAX_CONCURRENT_MOBILE : MAX_CONCURRENT_DESKTOP;
    const plans = planRipples(rippleInputs(mobile), {
      waterlinePct,
      vh: height,
      minX,
      maxX,
      xGap: MIN_RIPPLE_X_GAP,
      cap,
      horizon: 900,
    });

    expect(plans.length).toBeGreaterThan(0);
    for (const plan of plans) {
      expect(plan.at).toBeGreaterThan(0);
      expect(plan.at).toBeLessThan(1);
      expect(plan.x).toBeGreaterThanOrEqual(minX - 1e-9);
      expect(plan.x).toBeLessThanOrEqual(maxX + 1e-9);
    }
    for (let i = 1; i < plans.length; i++) {
      expect(plans[i].x - plans[i - 1].x).toBeGreaterThanOrEqual(MIN_RIPPLE_X_GAP - 1e-9);
    }
    expect(countConcurrent(plans, 900)).toBeLessThanOrEqual(cap);
  });

  it("移动端的涟漪数量少于桌面端", () => {
    const desktop = viewport(1440, 900);
    const mobile = viewport(390, 844);
    const desktopPlans = planRipples(rippleInputs(false), {
      ...desktop,
      xGap: MIN_RIPPLE_X_GAP,
      cap: MAX_CONCURRENT_DESKTOP,
      horizon: 900,
    });
    const mobilePlans = planRipples(rippleInputs(true), {
      ...mobile,
      xGap: MIN_RIPPLE_X_GAP,
      cap: MAX_CONCURRENT_MOBILE,
      horizon: 900,
    });
    expect(mobilePlans.length).toBeLessThan(desktopPlans.length);
    expect(mobilePlans.length).toBeLessThanOrEqual(rippleInputs(true).length);
  });

  it("输出各视口的涟漪数量与并发峰值（供人工核对）", () => {
    const rows = VIEWPORTS.map(([width, height]) => {
      const { waterlinePct, minX, maxX, mobile } = viewport(width, height);
      const cap = mobile ? MAX_CONCURRENT_MOBILE : MAX_CONCURRENT_DESKTOP;
      const plans = planRipples(rippleInputs(mobile), {
        waterlinePct,
        vh: height,
        minX,
        maxX,
        xGap: MIN_RIPPLE_X_GAP,
        cap,
        horizon: 900,
      });
      return {
        视口: `${width}×${height}`,
        水线: `${waterlinePct.toFixed(1)}%`,
        候选花瓣: rippleInputs(mobile).length,
        涟漪数: plans.length,
        并发峰值: countConcurrent(plans, 900),
        上限: cap,
        最早入水: `${(Math.min(...plans.map((p) => p.at)) * 100).toFixed(1)}%`,
        最晚入水: `${(Math.max(...plans.map((p) => p.at)) * 100).toFixed(1)}%`,
      };
    });
    // eslint-disable-next-line no-console
    console.table(rows);
    expect(rows).toHaveLength(VIEWPORTS.length);
  });
});
