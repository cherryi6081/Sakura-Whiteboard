/**
 * 湖面漂浮花瓣的静态排布。
 *
 * 现实里花瓣落到湖面会浮着，而不是入水即消失；画面只有「飘落」没有「漂着」，
 * 湖面会显得空。这一层是常驻装饰：每片自带一圈极淡的椭圆水纹，
 * 并每隔一段时间原地轻轻荡开一次，强度只有落瓣涟漪的一半左右。
 *
 * 排布遵守水面透视：
 * - depth 是湖带内的深浅（0 = 水线，1 = 画面底），越靠水线越远、越小、越扁；
 * - 横向铺满整个视口宽度（含超宽屏两侧用 CSS 湖带补出来的两翼）；
 * - 越靠底部越大、越接近正面视角（纵横比从约 0.46 抬到约 0.80）。
 *
 * 全部参数都是静态的，没有随机数：同一视口每次渲染的排布一致，可单测。
 */

export type FloatingPetal = {
  key: number;
  /** 视口宽度百分比 */
  x: number;
  /** 湖带内的深浅：0 = 水线，1 = 画面底 */
  depth: number;
  /** 基准宽度（px）：同时决定透视档位与档内大小，实际像素由鹤高比例推出 */
  size: number;
  /** 整体倾角（与水线不平行，读起来才像漂着） */
  rot: number;
  /** 花瓣自身的朝向 */
  tilt: number;
  /** 漂浮周期（s，24–38） */
  dur: number;
  /** 负延迟，让每片一上来就处在不同相位 */
  delay: number;
  /** 横向漂移 / 纵向起伏（px，几像素量级，不会被读成「被风吹跑」） */
  dx: number;
  dy: number;
  /** 自带涟漪的周期与延迟（s） */
  pulse: number;
  pulseDelay: number;
  /** 移动端是否保留（共 10 片：近 5 / 中 3 / 远 2） */
  mobile: boolean;
};

export const FLOATING_PETALS: readonly FloatingPetal[] = [
  // ---- 近处（depth .75–.92，缩放后 16.2–22.1px，纵横比约 0.72–0.80）----
  { key: 0, x: 12, depth: 0.8, size: 22, rot: -8, tilt: 14, dur: 30, delay: -4, dx: 6, dy: 3, pulse: 11, pulseDelay: -3, mobile: true },
  { key: 1, x: 29, depth: 0.9, size: 26, rot: 6, tilt: -18, dur: 34, delay: -19, dx: 5, dy: 4, pulse: 13, pulseDelay: -9, mobile: true },
  { key: 2, x: 45, depth: 0.77, size: 20, rot: 12, tilt: 8, dur: 27, delay: -11, dx: 7, dy: 3, pulse: 9.5, pulseDelay: -6, mobile: true },
  { key: 3, x: 60, depth: 0.92, size: 26, rot: -5, tilt: 20, dur: 38, delay: -27, dx: 4, dy: 4, pulse: 14, pulseDelay: -12, mobile: true },
  { key: 4, x: 74, depth: 0.83, size: 23, rot: 9, tilt: -10, dur: 31, delay: -8, dx: 6, dy: 3, pulse: 12, pulseDelay: -2, mobile: true },
  { key: 5, x: 87, depth: 0.88, size: 24, rot: -11, tilt: 6, dur: 29, delay: -16, dx: 5, dy: 3, pulse: 10.5, pulseDelay: -5, mobile: false },
  // 超宽屏右翼
  { key: 6, x: 95, depth: 0.75, size: 19, rot: 4, tilt: -22, dur: 26, delay: -3, dx: 7, dy: 2, pulse: 9, pulseDelay: -1, mobile: false },
  // 超宽屏左翼
  { key: 7, x: 4, depth: 0.86, size: 24, rot: -6, tilt: 16, dur: 33, delay: -22, dx: 5, dy: 4, pulse: 12.5, pulseDelay: -7, mobile: false },

  // ---- 中部（depth .44–.60，缩放后 11.1–13.6px，纵横比约 0.56–0.64）----
  { key: 8, x: 20, depth: 0.55, size: 15, rot: 10, tilt: -12, dur: 28, delay: -14, dx: 5, dy: 3, pulse: 10, pulseDelay: -4, mobile: true },
  { key: 9, x: 38, depth: 0.48, size: 14, rot: -14, tilt: 9, dur: 25, delay: -6, dx: 6, dy: 2, pulse: 8.5, pulseDelay: -10, mobile: true },
  { key: 10, x: 63, depth: 0.58, size: 16, rot: 7, tilt: 18, dur: 32, delay: -24, dx: 4, dy: 3, pulse: 11.5, pulseDelay: -8, mobile: true },
  { key: 11, x: 79, depth: 0.44, size: 13, rot: -9, tilt: -16, dur: 24, delay: -9, dx: 6, dy: 2, pulse: 9.5, pulseDelay: -13, mobile: false },
  // 超宽屏右翼
  { key: 12, x: 90, depth: 0.6, size: 15, rot: 13, tilt: 5, dur: 35, delay: -30, dx: 5, dy: 3, pulse: 13.5, pulseDelay: -15, mobile: false },
  // 超宽屏左翼
  { key: 13, x: 8, depth: 0.5, size: 13, rot: -4, tilt: 21, dur: 27, delay: -12, dx: 4, dy: 2, pulse: 10.5, pulseDelay: -11, mobile: false },

  // ---- 远处（depth .24–.32，缩放后 7.7–8.5px，纵横比约 0.46–0.50）----
  { key: 14, x: 33, depth: 0.28, size: 10, rot: 8, tilt: -14, dur: 29, delay: -17, dx: 4, dy: 2, pulse: 9, pulseDelay: -17, mobile: true },
  { key: 15, x: 68, depth: 0.24, size: 9, rot: -7, tilt: 11, dur: 26, delay: -5, dx: 5, dy: 2, pulse: 8.5, pulseDelay: -14, mobile: true },
  { key: 16, x: 15, depth: 0.32, size: 10, rot: 5, tilt: 17, dur: 30, delay: -21, dx: 4, dy: 2, pulse: 10, pulseDelay: -16, mobile: false },
  { key: 17, x: 82, depth: 0.26, size: 9, rot: -12, tilt: -8, dur: 28, delay: -13, dx: 5, dy: 2, pulse: 9.5, pulseDelay: -18, mobile: false },
];

/**
 * 花瓣尺寸不再用统一系数，而是按「花瓣长边 / 鹤的视觉高度」的档位比来定。
 *
 * 鹤在画面里的视觉高度 = CSS `--crane-h` × 1.3898（13° 倾角下的包围盒：
 * cos13° + 1.8462·sin13°）。这里把这套换算抽出来，CSS 用 `calc(var(--crane-h) * 比例 × 1.3898)`
 * 渲染，涟漪用同一函数算像素，两边永远同源。
 */
export const CRANE_VISUAL_TO_STAGE = 1.3898;

/** 与 pages.css 的 `--crane-h` 同源（移动端断点 767，与 nth-child 收口一致） */
export function craneStageHeight(width: number, height: number): number {
  return width <= 767
    ? Math.min(84, Math.max(58, 0.08 * height))
    : Math.min(132, Math.max(76, 0.092 * height));
}

/** 鹤的屏幕视觉高度（含倾角包围盒），作为花瓣比例的基准 */
export function craneVisualHeight(width: number, height: number): number {
  return craneStageHeight(width, height) * CRANE_VISUAL_TO_STAGE;
}

/** 单朵长边下限：桌面 4px、移动端 3px */
export function petalFloor(width: number): number {
  return width <= 767 ? 3 : 4;
}

/** 长边 = 档位比例 × 鹤视觉高度；低于下限就按下限截断 */
export function petalEdgePx(ratio: number, width: number, height: number): number {
  const raw = ratio * craneVisualHeight(width, height);
  return +Math.max(petalFloor(width), raw).toFixed(2);
}

function lerp(from: number, to: number, t: number) {
  return from + (to - from) * Math.min(1, Math.max(0, t));
}

/**
 * 飘落花瓣的长边比（相对鹤的视觉高度），按基准 size 在档内线性展开：
 * 近档（17–24）8–10%，中档（13–16）5–6%，远档（10–12）3–4%。
 * 档内保留差异，否则同档花瓣会变成一排一模一样的小圆片。
 */
export function fallingRatioBySize(size: number): number {
  if (size >= 17) return lerp(0.08, 0.1, (size - 17) / 7);
  if (size >= 13) return lerp(0.05, 0.06, (size - 13) / 3);
  return lerp(0.03, 0.04, (size - 10) / 2);
}

/** 漂浮花瓣比：近（19–26）5–6%，中（13–16）4–5%，远（9–10）3–3.5% */
export function floatingRatioBySize(size: number): number {
  if (size >= 19) return lerp(0.05, 0.06, (size - 19) / 7);
  if (size >= 13) return lerp(0.04, 0.05, (size - 13) / 3);
  return lerp(0.03, 0.035, (size - 9) / 1);
}

/** 纵轴压缩：越靠水线越扁（远处近似被压成一条横线），越靠底越接近正面视角 */
export function floatingFootprint(petal: FloatingPetal, width: number, height: number) {
  const aspect = 0.34 + 0.5 * petal.depth;
  const size = petalEdgePx(floatingRatioBySize(petal.size), width, height);
  return { width: size, height: +(size * aspect).toFixed(1), aspect: +aspect.toFixed(2) };
}

export type FloatingBand = "far" | "mid" | "near";

export function floatingBand(depth: number): FloatingBand {
  if (depth < 0.4) return "far";
  if (depth < 0.7) return "mid";
  return "near";
}

/** 移动端实际显示的片数（CSS 用 data-mobile 收口，这里给单测与自检复用） */
export function floatingCount(mobile: boolean) {
  return FLOATING_PETALS.filter((petal) => !mobile || petal.mobile).length;
}
