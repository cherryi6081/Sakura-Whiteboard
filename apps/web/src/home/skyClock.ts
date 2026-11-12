import type { Period } from "./usePeriod";

/**
 * 首页的「一盏钟」：天空八档、湖面四档、雾带由同一份状态驱动。
 *
 * 为什么需要它：山体与鹤吃的是 three 的 DirectionalLight/HemisphereLight，
 * 由 renderer 里的 currentSun 以 1 − exp(−delta × 1.4) 阻尼跟随 targetSun；
 * 而天空是 CSS 渐变、湖面是着色器固有色，原来都只在挂载时读一次 :root，
 * 于是换时辰时「山已经变完、天空还在旧色」。
 *
 * 这里把同一套阻尼用到天空/湖面/雾上，并在同一个 tick 里做两件事：
 *   1. 把当前值写回 .wb-home__scene 的 12 个 CSS 变量（天空渐变、超宽屏两翼湖带、
 *      SVG 的湖面/倒影渐隐都读这些变量）；
 *   2. 把当前值暴露给渲染器（水面四档 + uSky、雾带颜色、倒影 uHaze）。
 * 渲染器在同一个 tick 里先调 tick() 再 applySun()，所以四路输出同帧、同曲线。
 *
 * 插值在 **sRGB 通道**上做：线性空间里「蓝灰 → 暖橙」的中段会明显偏亮（发灰），
 * 与 palette.ts 里 mixSrgb 的取舍一致。常量 1.4 与主光完全相同。
 *
 * 这个文件不 import three：移动端（SVG 分支）也要用它，不能为了一盏钟把 three 拉进首屏。
 */

export type Srgb = readonly [number, number, number];

/** 与 tokens.css 的 --sky-* 顺序一一对应 */
const SKY_VARS = [
  "--sky-zenith",
  "--sky-high",
  "--sky-mid",
  "--sky-rose",
  "--sky-peach",
  "--sky-glow",
  "--sky-haze",
  "--sky-horizon",
] as const;

/** 与 tokens.css 的 --lake-* 顺序一一对应（近水 → 湖底） */
const LAKE_VARS = ["--lake-100", "--lake-300", "--lake-500", "--lake-700"] as const;

/** 与主光完全相同的阻尼常数：τ ≈ 0.71s，95% ≈ 2.1s，99% ≈ 3.3s */
const DAMPING = 1.4;

/**
 * 白天这一列必须与 tokens.css 现值逐通道相同（不改任何观感）。
 * 湖面四档不写死 hex，而是按 palette.ts 的同一组权重从 --fuji-* 与地平线混出来，
 * 这样年 WebGL 的初始 uniform 与新钟的首帧值在浮点层面就是同一个数，白天 ΔL 必然为 0。
 */
const FUJI_400: Srgb = [157, 184, 208];
const FUJI_500: Srgb = [132, 161, 189];
const FUJI_600: Srgb = [107, 135, 164];
const SNOW: Srgb = [247, 251, 254];
const DAY_HORIZON: Srgb = [240, 246, 251];

const mix = (a: Srgb, b: Srgb, t: number): Srgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

export type SkyTarget = {
  /** 天顶 → 地平线八个色标 */
  sky: Srgb[];
  /** 近水 → 湖底四档 */
  lake: Srgb[];
  /** 雾带 / 倒影提浅用的雾色 */
  mist: Srgb;
};

export const PERIOD_SKY: Record<Period, SkyTarget> = {
  // 白天：现值原样。天空就是 tokens.css 的 --sky-*，湖面与雾由同一组权重混出
  day: {
    sky: [
      [189, 208, 234],
      [198, 210, 236],
      [217, 211, 234],
      [233, 223, 234],
      [246, 233, 230],
      [252, 235, 226],
      [248, 243, 242],
      [240, 246, 251],
    ],
    lake: [
      mix(FUJI_400, DAY_HORIZON, 0.45),
      mix(FUJI_500, DAY_HORIZON, 0.4),
      mix(FUJI_500, DAY_HORIZON, 0.3),
      mix(FUJI_600, DAY_HORIZON, 0.5),
    ],
    mist: mix(SNOW, DAY_HORIZON, 0.45),
  },
  // 黎明：只比白天冷一档，天顶压深、地平线偏粉，黑字仍能守住对比度
  dawn: {
    sky: [
      [173, 194, 224],
      [185, 203, 230],
      [207, 210, 233],
      [227, 217, 231],
      [245, 227, 226],
      [252, 234, 222],
      [248, 240, 240],
      [237, 243, 249],
    ],
    lake: [
      [193, 210, 226],
      [174, 194, 213],
      [164, 185, 207],
      [172, 189, 206],
    ],
    mist: [242, 247, 252],
  },
  // 黄昏：天顶薰衣草、地平线暖橙；山体只由暖主光负责，不再靠叠色把它染粉
  dusk: {
    sky: [
      [177, 174, 212],
      [191, 178, 210],
      [211, 188, 205],
      [232, 200, 194],
      [245, 216, 189],
      [251, 223, 194],
      [248, 233, 222],
      [242, 238, 240],
    ],
    lake: [
      [195, 208, 222],
      [176, 192, 209],
      [165, 184, 204],
      [174, 186, 202],
    ],
    mist: [244, 245, 247],
  },
  // 夜：真夜空（天顶 L≈.037）。湖色单独降配比，比月光下的山更暗；
  // 导航/页脚/朱印在这一档反白，对比度由 pages.css 的 [data-period="night"] 负责
  night: {
    sky: [
      [44, 53, 80],
      [54, 63, 92],
      [65, 74, 104],
      [76, 83, 114],
      [87, 92, 123],
      [95, 100, 130],
      [96, 101, 131],
      [102, 109, 137],
    ],
    lake: [
      [109, 124, 149],
      [93, 107, 132],
      [82, 96, 118],
      [70, 82, 103],
    ],
    mist: [131, 138, 160],
  },
};

export type SkyState = {
  sky: number[][];
  lake: number[][];
  mist: number[];
  /** 只有色值真的变了才 +1：渲染器据此跳过无意义的 uniform 写入 */
  revision: number;
  settled: boolean;
  period: Period;
};

export type SkyClock = {
  readonly state: SkyState;
  /** 换档：只改目标，动画交给 tick；与主光同帧发生 */
  setPeriod(period: Period): void;
  /** 推进一帧；delta 由驱动方给（WebGL 用渲染器的 clamp(0.05)，SVG 用 rAF） */
  tick(delta: number): void;
  dispose(): void;
};

function toHex(value: number): string {
  const v = Math.max(0, Math.min(255, Math.round(value)));
  return v.toString(16).padStart(2, "0");
}

function cssColor(rgb: readonly number[]): string {
  return `#${toHex(rgb[0])}${toHex(rgb[1])}${toHex(rgb[2])}`;
}

function cloneTarget(target: SkyTarget): SkyState {
  return {
    sky: target.sky.map((c) => [...c]),
    lake: target.lake.map((c) => [...c]),
    mist: [...target.mist],
    revision: 0,
    settled: true,
    period: "day",
  };
}

/**
 * @param root 写 CSS 变量的元素（.wb-home__scene）。变量只写在这里，
 *   不写 :root：SVG 分支也靠这条路径过渡，写 :root 会污染其它页面的 token。
 * @param period 首帧即对齐的时辰（不在挂载时做动画，避免闪一下）
 */
export function createSkyClock(root: HTMLElement, period: Period): SkyClock {
  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const state = cloneTarget(PERIOD_SKY[period]);
  state.period = period;
  const target = cloneTarget(PERIOD_SKY[period]);

  /** 上一次真正写进 DOM 的字符串，用来做 1/255 节流 */
  const written: string[] = new Array(SKY_VARS.length + LAKE_VARS.length + 1).fill("");

  const write = (index: number, name: string, rgb: readonly number[]) => {
    const css = cssColor(rgb);
    if (written[index] === css) return false;
    written[index] = css;
    root.style.setProperty(name, css);
    return true;
  };

  const commit = (force: boolean) => {
    let changed = false;
    for (let i = 0; i < SKY_VARS.length; i += 1) {
      if (write(i, SKY_VARS[i], state.sky[i])) changed = true;
    }
    for (let i = 0; i < LAKE_VARS.length; i += 1) {
      if (write(SKY_VARS.length + i, LAKE_VARS[i], state.lake[i])) changed = true;
    }
    // 雾色不进 CSS，但 revision 要跟着它一起变，渲染器才会更新 uniform
    const mistCss = cssColor(state.mist);
    if (written[written.length - 1] !== mistCss) {
      written[written.length - 1] = mistCss;
      changed = true;
    }
    if (changed || force) state.revision += 1;
  };

  const lerpArray = (current: number[], goal: readonly number[], k: number) => {
    let max = 0;
    for (let i = 0; i < current.length; i += 1) {
      const diff = goal[i] - current[i];
      current[i] += diff * k;
      const abs = Math.abs(diff);
      if (abs > max) max = abs;
    }
    return max;
  };

  const snap = () => {
    for (let i = 0; i < state.sky.length; i += 1) state.sky[i] = [...target.sky[i]];
    for (let i = 0; i < state.lake.length; i += 1) state.lake[i] = [...target.lake[i]];
    state.mist = [...target.mist];
  };

  commit(true);

  return {
    state,
    setPeriod(next: Period) {
      if (state.period === next) return;
      state.period = next;
      const goal = PERIOD_SKY[next];
      for (let i = 0; i < target.sky.length; i += 1) target.sky[i] = [...goal.sky[i]];
      for (let i = 0; i < target.lake.length; i += 1) target.lake[i] = [...goal.lake[i]];
      target.mist = [...goal.mist];
      state.settled = false;
    },
    tick(delta: number) {
      if (state.settled) return;
      if (reduced) {
        snap();
        state.settled = true;
        commit(true);
        return;
      }
      const k = 1 - Math.exp(-Math.max(0, delta) * DAMPING);
      let max = 0;
      for (let i = 0; i < state.sky.length; i += 1) {
        max = Math.max(max, lerpArray(state.sky[i], target.sky[i], k));
      }
      for (let i = 0; i < state.lake.length; i += 1) {
        max = Math.max(max, lerpArray(state.lake[i], target.lake[i], k));
      }
      max = Math.max(max, lerpArray(state.mist, target.mist, k));
      // 已经落到同一个 8bit 值就收口：之后不再写任何变量
      if (max < 0.5) {
        snap();
        state.settled = true;
      }
      commit(false);
    },
    dispose() {
      for (const name of SKY_VARS) root.style.removeProperty(name);
      for (const name of LAKE_VARS) root.style.removeProperty(name);
    },
  };
}
