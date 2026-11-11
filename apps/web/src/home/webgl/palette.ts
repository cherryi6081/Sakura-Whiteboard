import * as THREE from "three";
import type { Period } from "../usePeriod";

/** 从 :root 读 CSS 变量；拿不到或解析失败就退回给定色值，保证 WebGL 永远有颜色可用 */
function cssColor(name: string, fallback: string): THREE.Color {
  if (typeof window === "undefined") return new THREE.Color(fallback);
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!raw) return new THREE.Color(fallback);
  try {
    return new THREE.Color(raw);
  } catch {
    return new THREE.Color(fallback);
  }
}

/**
 * 与 --lake-* 同一套混色规则（那几个 token 是 color-mix(in srgb, …)，JS 里必须自己算）。
 * 注意必须在 sRGB 通道上插值：THREE.Color 内部是线性空间，直接 lerp 会让混色明显偏亮，
 * 和 CSS 的 color-mix(in srgb) 对不上，湖面就会比 SVG 版白一档。
 */
function mixSrgb(a: THREE.Color, b: THREE.Color, t: number): THREE.Color {
  return a
    .clone()
    .convertLinearToSRGB()
    .lerp(b.clone().convertLinearToSRGB(), t)
    .convertSRGBToLinear();
}

export type Palette = {
  /** 山体：上浅下深，山脚再压一档 */
  rock: THREE.Color;
  rockDeep: THREE.Color;
  rockFoot: THREE.Color;
  snow: THREE.Color;
  snowShade: THREE.Color;
  /** 湖面四档（水线 → 湖底），对应 SVG 的 0 / 28 / 66 / 100% */
  lake: [THREE.Color, THREE.Color, THREE.Color, THREE.Color];
  horizon: THREE.Color;
  ripple: THREE.Color;
  /** 花瓣：浅粉到深粉 */
  petalLight: THREE.Color;
  petalDeep: THREE.Color;
  mist: THREE.Color;
};

export function readPalette(): Palette {
  const fuji300 = cssColor("--fuji-300", "#b7cde0");
  const fuji400 = cssColor("--fuji-400", "#9db8d0");
  const fuji500 = cssColor("--fuji-500", "#84a1bd");
  const fuji600 = cssColor("--fuji-600", "#6b87a4");
  const snow = cssColor("--fuji-snow", "#f7fbfe");
  const snowShade = cssColor("--fuji-snow-shade", "#dce9f6");
  const horizon = cssColor("--sky-horizon", "#f0f6fb");

  return {
    rock: fuji300,
    // 山顶到山脚只压两档：颜色越接近 SVG 的浅蓝，越像版画底稿，而不是写实火山
    rockDeep: fuji400,
    rockFoot: fuji500,
    snow,
    snowShade,
    // 与 tokens.css 的 --lake-100/300/500/700 同源
    lake: [
      mixSrgb(fuji400, horizon, 0.45),
      mixSrgb(fuji500, horizon, 0.4),
      mixSrgb(fuji500, horizon, 0.3),
      mixSrgb(fuji600, horizon, 0.5),
    ],
    horizon,
    ripple: mixSrgb(cssColor("--paper", "#ffffff"), horizon, 0.26),
    petalLight: cssColor("--rose-100", "#f4e3e9"),
    petalDeep: cssColor("--rose-400", "#cc8aa5"),
    mist: mixSrgb(snow, horizon, 0.45),
  };
}

export type SunState = {
  /** 主光颜色与强度 */
  color: THREE.Color;
  intensity: number;
  /** 天光：上半球 / 地面反光 */
  sky: THREE.Color;
  ground: THREE.Color;
  hemiIntensity: number;
  /** 光源方向（由场景指向光源） */
  dir: THREE.Vector3;
};

/**
 * 光照方向与色温随时辰偏移：
 * 黎明冷光从左侧低角度打来、白天偏正上方、黄昏换成右侧的更暖橙光、夜里冷蓝且整体压暗。
 * 只改光，不改材质底色 —— 山体的蓝仍是 --fuji-*，保证与移动端 SVG 同一套色。
 */
export const PERIOD_SUN: Record<Period, SunState> = {
  // 色温只做小幅偏移：山体底色是蓝的，光色一旦饱和就会把山染成褐 / 紫，
  // 所以主光都贴近白，只留一丝冷暖；整体氛围交给 CSS 的 data-period 叠色。
  dawn: {
    color: new THREE.Color("#ffe3d6"),
    intensity: 2.25,
    sky: new THREE.Color("#dfe4f6"),
    ground: new THREE.Color("#a49aa8"),
    hemiIntensity: 0.95,
    dir: new THREE.Vector3(-0.72, 0.42, 0.55).normalize(),
  },
  day: {
    color: new THREE.Color("#fff8ec"),
    intensity: 2.6,
    sky: new THREE.Color("#e7f3ff"),
    ground: new THREE.Color("#a3b8ca"),
    hemiIntensity: 0.9,
    dir: new THREE.Vector3(-0.45, 0.72, 0.58).normalize(),
  },
  dusk: {
    // 黄昏只保留“低角度暖光”的方向感，不再把整座山染成粉褐：
    // 主光 #ffd9bd → #fff4e8（通道差 26% → 9%，强度 2.2 → 2.1），
    // 半球天光 #dcd0ea → #e6eef9（紫调薰衣草 → 冷蓝白），
    // 地面反光 #a08a90 → #a8b7c5（偏紫褐 → 蓝灰）。
    // 这不等于把黄昏做成白天：斜射主光仍只有 2.1，山体整体比 day 低约 0.06 相对亮度，
    // 暖调交给 CSS 的黄昏叠色与天空暖光晕，山体只负责守住自己的蓝灰固有色。
    color: new THREE.Color("#fff4e8"),
    intensity: 2.1,
    sky: new THREE.Color("#e6eef9"),
    ground: new THREE.Color("#a8b7c5"),
    hemiIntensity: 0.9,
    dir: new THREE.Vector3(0.68, 0.34, 0.52).normalize(),
  },
  night: {
    color: new THREE.Color("#cdd9f2"),
    intensity: 1.25,
    sky: new THREE.Color("#8d9cc8"),
    ground: new THREE.Color("#55607a"),
    hemiIntensity: 0.7,
    dir: new THREE.Vector3(0.55, 0.78, 0.42).normalize(),
  },
};
