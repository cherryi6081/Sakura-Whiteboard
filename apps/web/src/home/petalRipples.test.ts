import { describe, expect, it } from "vitest";
import { LEFT_PETALS, PETALS, petalGeometry } from "./FujiScene";
import {
  CONCURRENCY_WINDOW,
  INNER_PEAK_OPACITY,
  INNER_SPLASH_SECONDS,
  MAX_CONCURRENT_DESKTOP,
  MAX_CONCURRENT_MOBILE,
  MAX_RIPPLE_GAP_SECONDS,
  MIN_RIPPLE_X_GAP_PX,
  MIN_RIPPLE_X_GAP_PX_MOBILE,
  OUTER_PEAK_OPACITY,
  OUTER_SPLASH_SECONDS,
  countConcurrent,
  longestGapSeconds,
  petalFade,
  planRippleSet,
  planRipples,
  splashFrames,
  timeAtDown,
  waterTime,
  type PetalPath,
  type RippleInput,
} from "./petalRipples";

const PATHS: PetalPath[] = ["a", "b", "c", "d"];

/**
 * 与 FujiScene 的 effect 完全一致：触发区域是水线以下的整片水面（0–100%），
 * 不再按山体倒影的 16:9 内容宽度收窄
 */
function viewport(width: number, height: number) {
  const contentH = Math.min(0.5625 * width, height);
  const waterlinePct = ((height - 0.371111 * contentH) / height) * 100;
  return { waterlinePct, minX: 0, maxX: 100, mobile: width <= 767, vh: height };
}

/** 超宽屏两侧 CSS 湖带的边界：内容区（16:9）之外的左右两翼 */
function wingBounds(width: number, height: number) {
  const contentW = (Math.min(0.5625 * width, height) / 900) * 1600;
  const wing = Math.max(0, ((width - contentW) / 2 / width) * 100);
  return { left: wing, right: 100 - wing };
}

/** 组装涟漪输入，移动端按 pages.css 的 nth-child 收口过滤 */
function rippleInputs(width: number, height: number): RippleInput[] {
  const { mobile } = viewport(width, height);
  const all = [...PETALS, ...LEFT_PETALS];
  const out: RippleInput[] = [];
  all.forEach((petal, key) => {
    const localIndex = key < PETALS.length ? key : key - PETALS.length;
    const limit = key < PETALS.length ? 16 : 8;
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

  it.each(VIEWPORTS)("%i×%i：花瓣在水线处才淡出，淡出窗口包住入水时刻", (width, height) => {
    const { waterlinePct } = viewport(width, height);
    for (const input of rippleInputs(width, height)) {
      const at = waterTime(input, waterlinePct, height);
      const fade = petalFade(at);
      // 入水之前一直保持满透明度，入水之后才开始收
      expect(fade.start).toBeLessThanOrEqual(at);
      expect(fade.end).toBeGreaterThan(at);
      expect(fade.end).toBeLessThanOrEqual(1);
      // 淡出窗口很短：不会出现「花瓣在半空里慢慢淡掉」
      expect(fade.end - fade.start).toBeLessThanOrEqual(0.04);
    }
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

  it("两圈的时长与峰值都在“轻微但看得见”的范围内", () => {
    for (const seconds of [OUTER_SPLASH_SECONDS, INNER_SPLASH_SECONDS]) {
      expect(seconds).toBeGreaterThanOrEqual(1.2);
      expect(seconds).toBeLessThanOrEqual(1.8);
    }
    // 上一版 0.32 实测只有 9 个色阶，肉眼看不见；这里锁死「够亮但仍半透明」的区间
    expect(OUTER_PEAK_OPACITY).toBeGreaterThanOrEqual(0.45);
    expect(OUTER_PEAK_OPACITY).toBeLessThanOrEqual(0.6);
    expect(INNER_PEAK_OPACITY).toBeLessThan(OUTER_PEAK_OPACITY);
  });
});

describe("涟漪落点与并发", () => {
  /** 与 FujiScene 完全一致的参数：移动端用更小的横向间距 */
  const optionsFor = (width: number, height: number) => {
    const { waterlinePct, minX, maxX, mobile } = viewport(width, height);
    const gapPx = mobile ? MIN_RIPPLE_X_GAP_PX_MOBILE : MIN_RIPPLE_X_GAP_PX;
    const gaps = (gapPx / width) * 100;
    const cap = mobile ? MAX_CONCURRENT_MOBILE : MAX_CONCURRENT_DESKTOP;
    return {
      mobile,
      cap,
      gapPct: gaps,
      gapPx,
      options: { waterlinePct, vh: height, minX, maxX, xGap: gaps, cap, horizon: 900 },
    };
  };

  /** 只要两片在同一时刻都可见，横向就必须至少错开设定间距（12px / 5px），否则算「叠成一坨」 */
  const assertNoBlob = (plans: ReturnType<typeof planRipples>, gapPct: number) => {
    for (let i = 0; i < plans.length; i++) {
      for (let j = i + 1; j < plans.length; j++) {
        if (Math.abs(plans[i].x - plans[j].x) >= gapPct - 1e-9) continue;
        // 展开两片的出现时刻，检查是否有重叠窗口
        const startsOf = (plan: (typeof plans)[number]) => {
          const phase = (((plan.delay + plan.at * plan.cycle) % plan.cycle) + plan.cycle) % plan.cycle;
          const starts: number[] = [];
          for (let t = phase; t < 120; t += plan.cycle) starts.push(t);
          return starts;
        };
        for (const a of startsOf(plans[i])) {
          for (const b of startsOf(plans[j])) {
            const overlap = Math.min(a + OUTER_SPLASH_SECONDS, b + OUTER_SPLASH_SECONDS) - Math.max(a, b);
            expect(overlap).toBeLessThanOrEqual(0);
          }
        }
      }
    }
  };

  it.each(VIEWPORTS)(
    "%i×%i：落点在水线以下水域、横向不越界、并发不超上限、任意 4s 内都有涟漪",
    (width, height) => {
      const { cap, options } = optionsFor(width, height);
      const plans = planRipples(rippleInputs(width, height), options);

      expect(plans.length).toBeGreaterThan(0);
      for (const plan of plans) {
        expect(plan.at).toBeGreaterThan(0);
        expect(plan.at).toBeLessThan(1);
        expect(plan.x).toBeGreaterThanOrEqual(options.minX - 1e-9);
        expect(plan.x).toBeLessThanOrEqual(options.maxX + 1e-9);
      }
      expect(countConcurrent(plans, 900, CONCURRENCY_WINDOW)).toBeLessThanOrEqual(cap);
      // 4s 空档是硬指标：用户随手一瞥就应该至少看到一次
      expect(longestGapSeconds(plans, 900)).toBeLessThanOrEqual(MAX_RIPPLE_GAP_SECONDS);
      // 同一横坐标附近不会同时叠两圈
      assertNoBlob(plans, options.xGap);
    },
  );

  it("移动端的涟漪数量少于桌面端", () => {
    const desktop = optionsFor(1440, 900);
    const mobile = optionsFor(390, 844);
    const desktopPlans = planRipples(rippleInputs(1440, 900), desktop.options);
    const mobilePlans = planRipples(rippleInputs(390, 844), mobile.options);
    expect(mobilePlans.length).toBeLessThan(desktopPlans.length);
    expect(mobilePlans.length).toBeLessThanOrEqual(rippleInputs(390, 844).length);
  });

  it.each(VIEWPORTS)("%i×%i：左右两翼（16:9 内容区之外）也能落涟漪", (width, height) => {
    const { options } = optionsFor(width, height);
    const { plans } = planRippleSet(rippleInputs(width, height), options);
    const { left, right } = wingBounds(width, height);
    if (left <= 0) {
      // 非超宽屏没有 CSS 湖带，整幅画面都是水面
      expect(plans.every((plan) => plan.x >= 0 && plan.x <= 100)).toBe(true);
      return;
    }
    const leftWing = plans.filter((plan) => plan.x < left).length;
    const rightWing = plans.filter((plan) => plan.x > right).length;
    expect(leftWing).toBeGreaterThan(0);
    expect(rightWing).toBeGreaterThan(0);
  });

  it("输出各视口的落点去向、并发峰值与最长空档（供人工核对）", () => {
    const rows = VIEWPORTS.map(([width, height]) => {
      const { cap, gapPx, options } = optionsFor(width, height);
      const { plans, stats } = planRippleSet(rippleInputs(width, height), options);
      const { left, right } = wingBounds(width, height);
      return {
        视口: `${width}×${height}`,
        水线: `${options.waterlinePct.toFixed(1)}%`,
        输入: stats.inputs,
        挂动画: stats.kept,
        周期外: stats.outsideCycle,
        越界: stats.outsideX,
        间距冲突: stats.blockedByGap,
        并发裁剪: stats.droppedByCap,
        左翼: plans.filter((plan) => plan.x < left).length,
        中间: plans.filter((plan) => plan.x >= left && plan.x <= right).length,
        右翼: plans.filter((plan) => plan.x > right).length,
        上限: cap,
        并发峰值: countConcurrent(plans, 900, CONCURRENCY_WINDOW),
        最长空档: `${longestGapSeconds(plans, 900).toFixed(2)}s`,
        间距: `${gapPx}px`,
      };
    });
    // eslint-disable-next-line no-console
    console.table(rows);
    expect(rows).toHaveLength(VIEWPORTS.length);
  });
});
