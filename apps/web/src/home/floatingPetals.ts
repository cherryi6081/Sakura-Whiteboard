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

/* ---------------------------------------------------------------------------
 * 花瓣轮廓：SVG 与 WebGL 共用的唯一形状源
 *
 * 一朵真樱花瓣的轮廓：基部收窄成圆角（贴着花梗），中段最宽，末端保持宽肩、
 * 只在正中留一道 V 形缺刻；左右不对称、边缘带一点低频起伏。
 *
 * 这里用 3 段三次贝塞尔画右半侧轮廓到肩部，4 段二次贝塞尔画「圆瓣 → 缺口 →
 * 缺口 → 圆瓣」，再把右半侧镜像成左半（左半压窄 6%、整体低 1.2%，并叠一层低频
 * 扰动），采样成一条 38 点的闭合多边形。
 * - SVG 端：PETAL_CLIP_PATH 把它写成 CSS polygon()，直接裁花瓣元素；
 * - WebGL 端：webgl/petals.ts 把同一组点烘成有向距离图。
 * 两端读的是同一份数组，形状不会一个尖一个圆。
 *
 * 归一化后 x、y 都落在 [-1, 1]：花瓣盒子宽 = 1、高 = 1.33（见 pages.css），
 * 盒子比「高」是为了让剪影读起来是花瓣而不是心形——同样填满盒子，方盒子会把
 * 基部收窄 + 末端缺刻读成心形的尖底与心口。着色器里的四边形按同一比例铺，
 * 两端像素尺寸一致。
 * ------------------------------------------------------------------------- */

type ShapePoint = readonly [number, number];

/** 右半侧：基部 (0,−1) → 最宽 (0.72,0.02) → 肩 (0.52,0.86) */
const PETAL_RIGHT: ReadonlyArray<readonly [ShapePoint, ShapePoint, ShapePoint, ShapePoint]> = [
  [[0.0, -1.0], [0.1, -1.0], [0.26, -0.95], [0.4, -0.79]],
  [[0.4, -0.79], [0.6, -0.6], [0.71, -0.3], [0.72, 0.02]],
  [[0.72, 0.02], [0.73, 0.34], [0.66, 0.66], [0.52, 0.86]],
];

/**
 * 末端：右圆瓣 (0.28,0.995) → 谷底 (0,0.80) → 左圆瓣 (−0.28,0.995) → 左肩。
 * 缺口宽约全宽的 39%、深约全长的 10%：再宽会读成心口，再窄在小尺寸下就看不见
 */
const PETAL_NOTCH: ReadonlyArray<readonly [ShapePoint, ShapePoint, ShapePoint]> = [
  [[0.52, 0.86], [0.45, 0.965], [0.28, 0.995]],
  [[0.28, 0.995], [0.12, 0.86], [0.0, 0.8]],
  [[0.0, 0.8], [-0.12, 0.86], [-0.28, 0.995]],
  [[-0.28, 0.995], [-0.45, 0.965], [-0.52, 0.86]],
];

function cubicAt(p0: ShapePoint, p1: ShapePoint, p2: ShapePoint, p3: ShapePoint, t: number): ShapePoint {
  const v = 1 - t;
  const a = v * v * v;
  const b = 3 * v * v * t;
  const c = 3 * v * t * t;
  const d = t * t * t;
  return [
    a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
    a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
  ];
}

function quadAt(p0: ShapePoint, p1: ShapePoint, p2: ShapePoint, t: number): ShapePoint {
  const v = 1 - t;
  return [
    v * v * p0[0] + 2 * v * t * p1[0] + t * t * p2[0],
    v * v * p0[1] + 2 * v * t * p1[1] + t * t * p2[1],
  ];
}

function buildPetalOutline(): ShapePoint[] {
  const STEPS = 4;

  const right: ShapePoint[] = [[0.02, -1.0]];
  for (const [p0, p1, p2, p3] of PETAL_RIGHT) {
    for (let i = 1; i <= STEPS; i += 1) right.push(cubicAt(p0, p1, p2, p3, i / STEPS));
  }
  // 右半侧边缘的自然起伏：低频、幅度不到 1%，只在大尺寸下看得出来
  const rightWavy = right.map<ShapePoint>(([x, y]) => [
    x + 0.006 * Math.sin(4.1 * y + 0.8),
    y + 0.004 * Math.sin(2.9 * x - 0.5),
  ]);

  const notch: ShapePoint[] = [];
  for (const [p0, p1, p2] of PETAL_NOTCH) {
    for (let i = 1; i <= 3; i += 1) notch.push(quadAt(p0, p1, p2, i / 3));
  }

  // 左半侧 = 右半侧镜像：压窄 6%、整体低 1.2%，再叠一层更明显的扰动，读起来是「略不对称」。
  // 扰动走乘性缩放而不是加常量，否则负半轴上会出现回折的小尖
  const left = [...rightWavy].reverse().map<ShapePoint>(([x, y]) => [
    -x * 0.94 * (1 + 0.006 * Math.sin(5.3 * y + 1.4)),
    y - 0.012 + 0.008 * Math.sin(3.6 * x - 0.7),
  ]);

  const raw = [...rightWavy, ...notch, ...left];
  const xs = raw.map(([x]) => x);
  const ys = raw.map(([, y]) => y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const hx = (maxX - minX) / 2;
  const hy = (maxY - minY) / 2;

  return raw.map(([x, y]) => [+((x - cx) / hx).toFixed(4), +((y - cy) / hy).toFixed(4)] as const);
}

/** 归一化轮廓（37 点，x/y ∈ [-1,1]）。WebGL 的有向距离图与 CSS 的 polygon 都由它派生 */
export const PETAL_OUTLINE: ReadonlyArray<ShapePoint> = buildPetalOutline();

/** 花瓣盒子的高宽比：轮廓按这个比例铺，形状才不被拉成心形（见 pages.css 的 .wb-scene__petal） */
export const PETAL_BOX_ASPECT = 1.33;

/** SVG 端用的裁剪路径（百分比，直接给 clip-path） */
export const PETAL_CLIP_PATH = `polygon(${PETAL_OUTLINE.map(
  ([x, y]) => `${(50 + x * 50).toFixed(1)}% ${(50 - y * 50).toFixed(1)}%`,
).join(", ")})`;

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
  /** 移动端是否保留（共 23 片） */
  mobile: boolean;
  /** 堆号：同一堆里的花瓣两两压叠、朝向不同；没有这个字段的是散片 */
  cluster?: "c1" | "c2" | "c3" | "c4";
};

/**
 * 湖面花瓣：34 片（桌面）/ 23 片（移动端），四堆 + 散片。
 *
 * 以前是 18 片均匀撒开，读起来像"湖面上几点粉色"。现在先按堆排布，再补散片：
 * - c1：左近景大堆 4 片（x≈6.4–7.3%，depth 0.85–0.91），相互压叠，朝向差 20°+
 * - c2：山体倒影正中（x≈45%，depth 0.22–0.25）3 片小堆，落在倒影的亮面上
 * - c3：倒影左肩（x≈28.5%，depth 0.30–0.33）3 片，和 c2 一起把"倒影一带"压得更密
 * - c4：右近景 4 片（x≈91.8–92.8%，depth 0.76–0.83）
 * 其余 20 片是散片，横向铺满、远近各留空档，形成"几处聚、几处散"的疏密。
 *
 * 排布顺序 = 绘制顺序：远 → 中 → 近，近处的花瓣压住远处的；堆内也按尺寸从小到大，
 * 大瓣压在小瓣上，读起来是"叠"而不是"排"。
 *
 * 船的禁入区（x 72.5–85%、depth 0.38–0.68）刻意留空：漂浮层 z-index 高于小舟，
 * 花瓣一旦落进这个矩形就会盖住船身，任何视口都不允许。
 */
export const FLOATING_PETALS: readonly FloatingPetal[] = [
  // ---- 远处散片（depth .24–.32）----
  { key: 0, x: 14.5, depth: 0.32, size: 10, rot: 8, tilt: -14, dur: 30, delay: -17, dx: 4, dy: 2, pulse: 9.0, pulseDelay: -3, mobile: true },
  { key: 1, x: 62.0, depth: 0.24, size: 9, rot: -7, tilt: 11, dur: 26, delay: -5, dx: 5, dy: 2, pulse: 8.5, pulseDelay: -14, mobile: true },
  { key: 2, x: 88.5, depth: 0.26, size: 9, rot: -12, tilt: -8, dur: 28, delay: -13, dx: 5, dy: 2, pulse: 9.5, pulseDelay: -18, mobile: false },
  { key: 3, x: 36.5, depth: 0.30, size: 10, rot: 5, tilt: 17, dur: 31, delay: -21, dx: 4, dy: 2, pulse: 10.0, pulseDelay: -16, mobile: true },

  // ---- c2：山体倒影正中的小堆（3 片，互相压叠）----
  { key: 4, x: 44.95, depth: 0.235, size: 9, rot: 13, tilt: 5, dur: 27, delay: -9, dx: 4, dy: 1, pulse: 8.8, pulseDelay: -7, mobile: true, cluster: "c2" },
  { key: 5, x: 45.30, depth: 0.250, size: 10, rot: -4, tilt: 21, dur: 33, delay: -22, dx: 3, dy: 2, pulse: 11.0, pulseDelay: -11, mobile: true, cluster: "c2" },
  { key: 6, x: 45.65, depth: 0.225, size: 9, rot: -16, tilt: -9, dur: 24, delay: -3, dx: 4, dy: 1, pulse: 9.2, pulseDelay: -19, mobile: false, cluster: "c2" },

  // ---- c3：倒影左肩的小堆（3 片）----
  { key: 7, x: 28.15, depth: 0.305, size: 9, rot: 10, tilt: -12, dur: 29, delay: -15, dx: 4, dy: 2, pulse: 9.7, pulseDelay: -5, mobile: true, cluster: "c3" },
  { key: 8, x: 28.50, depth: 0.320, size: 10, rot: -6, tilt: 16, dur: 25, delay: -6, dx: 3, dy: 2, pulse: 10.4, pulseDelay: -12, mobile: false, cluster: "c3" },
  { key: 9, x: 28.85, depth: 0.295, size: 11, rot: 3, tilt: -20, dur: 32, delay: -24, dx: 4, dy: 1, pulse: 12.0, pulseDelay: -17, mobile: true, cluster: "c3" },

  // ---- 中部散片（depth .44–.66，纵横比约 0.56–0.67）----
  { key: 10, x: 20.0, depth: 0.55, size: 15, rot: 10, tilt: -12, dur: 28, delay: -14, dx: 5, dy: 3, pulse: 10.0, pulseDelay: -4, mobile: true },
  { key: 11, x: 38.2, depth: 0.48, size: 14, rot: -14, tilt: 9, dur: 25, delay: -6, dx: 6, dy: 2, pulse: 8.6, pulseDelay: -10, mobile: false },
  { key: 12, x: 52.5, depth: 0.62, size: 16, rot: 7, tilt: 18, dur: 32, delay: -24, dx: 4, dy: 3, pulse: 11.5, pulseDelay: -8, mobile: true },
  { key: 13, x: 58.0, depth: 0.44, size: 11, rot: -9, tilt: -16, dur: 24, delay: -9, dx: 6, dy: 2, pulse: 9.4, pulseDelay: -13, mobile: true },
  { key: 14, x: 68.0, depth: 0.46, size: 13, rot: 12, tilt: 8, dur: 27, delay: -11, dx: 5, dy: 3, pulse: 9.8, pulseDelay: -6, mobile: false },
  { key: 15, x: 90.5, depth: 0.60, size: 15, rot: 13, tilt: 5, dur: 35, delay: -30, dx: 5, dy: 3, pulse: 13.5, pulseDelay: -15, mobile: true },
  { key: 16, x: 8.0, depth: 0.50, size: 13, rot: -4, tilt: 21, dur: 27, delay: -12, dx: 4, dy: 2, pulse: 10.5, pulseDelay: -21, mobile: true },
  { key: 17, x: 25.5, depth: 0.60, size: 16, rot: 9, tilt: -10, dur: 31, delay: -8, dx: 6, dy: 3, pulse: 12.0, pulseDelay: -2, mobile: true },

  // ---- 近处散片（depth .74–.92，纵横比约 0.71–0.80）----
  { key: 18, x: 17.5, depth: 0.90, size: 26, rot: 6, tilt: -18, dur: 34, delay: -19, dx: 5, dy: 4, pulse: 13.0, pulseDelay: -9, mobile: true },
  { key: 19, x: 33.2, depth: 0.86, size: 24, rot: -11, tilt: 6, dur: 29, delay: -16, dx: 5, dy: 3, pulse: 10.5, pulseDelay: -23, mobile: false },
  { key: 20, x: 48.5, depth: 0.92, size: 25, rot: -5, tilt: 20, dur: 38, delay: -27, dx: 4, dy: 4, pulse: 14.0, pulseDelay: -24, mobile: true },
  { key: 21, x: 56.5, depth: 0.81, size: 21, rot: 9, tilt: -10, dur: 31, delay: -8, dx: 6, dy: 3, pulse: 12.0, pulseDelay: -25, mobile: true },
  { key: 22, x: 63.5, depth: 0.88, size: 23, rot: -8, tilt: 14, dur: 30, delay: -4, dx: 6, dy: 3, pulse: 11.0, pulseDelay: -20, mobile: false },
  { key: 23, x: 70.5, depth: 0.78, size: 18, rot: 12, tilt: 8, dur: 27, delay: -11, dx: 7, dy: 3, pulse: 9.5, pulseDelay: -26, mobile: true },
  { key: 24, x: 87.0, depth: 0.88, size: 24, rot: -11, tilt: 6, dur: 29, delay: -16, dx: 5, dy: 3, pulse: 11.8, pulseDelay: -27, mobile: true },
  { key: 25, x: 97.0, depth: 0.74, size: 16, rot: 4, tilt: -22, dur: 26, delay: -3, dx: 7, dy: 2, pulse: 9.0, pulseDelay: -1, mobile: true },

  // ---- c1：左近景大堆（4 片，大瓣压小瓣）----
  { key: 26, x: 6.40, depth: 0.865, size: 19, rot: -8, tilt: 14, dur: 30, delay: -4, dx: 6, dy: 3, pulse: 11.0, pulseDelay: -28, mobile: false, cluster: "c1" },
  { key: 27, x: 6.90, depth: 0.845, size: 21, rot: 14, tilt: -6, dur: 34, delay: -19, dx: 5, dy: 4, pulse: 13.0, pulseDelay: -29, mobile: true, cluster: "c1" },
  { key: 28, x: 7.30, depth: 0.885, size: 22, rot: -16, tilt: 18, dur: 28, delay: -11, dx: 7, dy: 3, pulse: 9.5, pulseDelay: -30, mobile: false, cluster: "c1" },
  { key: 29, x: 6.70, depth: 0.905, size: 24, rot: 3, tilt: -24, dur: 38, delay: -27, dx: 4, dy: 4, pulse: 14.0, pulseDelay: -31, mobile: true, cluster: "c1" },

  // ---- c4：右近景堆（4 片，避开了上方的小舟）----
  { key: 30, x: 92.40, depth: 0.775, size: 16, rot: 10, tilt: -9, dur: 27, delay: -8, dx: 6, dy: 3, pulse: 10.0, pulseDelay: -32, mobile: false, cluster: "c4" },
  { key: 31, x: 91.80, depth: 0.805, size: 18, rot: -14, tilt: 12, dur: 31, delay: -16, dx: 5, dy: 3, pulse: 12.5, pulseDelay: -22, mobile: true, cluster: "c4" },
  { key: 32, x: 92.80, depth: 0.755, size: 20, rot: 6, tilt: -20, dur: 26, delay: -3, dx: 7, dy: 2, pulse: 9.2, pulseDelay: -33, mobile: false, cluster: "c4" },
  { key: 33, x: 92.10, depth: 0.825, size: 22, rot: -3, tilt: 8, dur: 33, delay: -22, dx: 5, dy: 4, pulse: 13.8, pulseDelay: -34, mobile: true, cluster: "c4" },
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
