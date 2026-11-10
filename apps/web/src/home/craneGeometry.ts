/**
 * 首页丹顶鹤：造型坐标、图层顺序与飞行关键帧的单一数据源。
 *
 * 坐标系：viewBox 0 0 240 130，一律「头朝右」绘制，向左飞由外层 scaleX(-1) 镜像，
 * 不画两套。所有部件共用这一套坐标，所以两翼的旋转原点可以落在同一个肩点上。
 *
 * 分层：SVG 本身没有 z-index，靠 DOM 顺序隐式成立正是之前几版出问题的原因
 * （躯干把近翼切开）。这里把七层写成显式数据，每层各挂一个独立 <svg>，
 * 用 CSS z-index 定位，撑不住 DOM 顺序变化也不会串层。
 */

export const CRANE_VIEWBOX = { width: 240, height: 130 } as const;

/** 两翼共同的肩点：近翼与远翼的 transform-origin 都落在这里，摆幅内翼根不脱肩 */
export const CRANE_SHOULDER = { x: 141, y: 58 } as const;

export type CraneLayerId = "leg" | "farWing" | "tail" | "neck" | "body" | "nearWing" | "head";

/**
 * 自下而上：腿 → 远翼 → 尾羽 → 颈 → 躯干 → 近翼 → 头颈细节。
 * 远翼只在翼根被躯干遮住（z 2 < 5），近翼整组压在躯干之上（6 > 5），
 * 所以任何振翅相位都不可能出现「躯干切开近翼」。
 */
export const CRANE_LAYERS: readonly { id: CraneLayerId; z: number }[] = [
  { id: "leg", z: 1 },
  { id: "farWing", z: 2 },
  { id: "tail", z: 3 },
  { id: "neck", z: 4 },
  { id: "body", z: 5 },
  { id: "nearWing", z: 6 },
  { id: "head", z: 7 },
];

/** 外层飞行的一个关键帧：位置是视口百分比（相对鹤的中心），rot 是视觉俯仰角（deg） */
export type CraneFlightFrame = {
  at: number;
  x: number;
  y: number;
  rot: number;
};

/**
 * 飞行关键帧（与 pages.css 的 @keyframes wb-crane-flight 一一对应，单测会比对）。
 *
 * 轨迹是一圈闭合回路：从右下起飞、向左上掠过山体，从左上出画，在画面外绕到右侧，
 * 再从右缘回到起点。因为整段只在「向左」的腿上可见，鸟头始终对着运动方向，
 * 不需要中途翻转朝向；0% 与 100% 的位置、角度完全相同，循环处不跳帧。
 *
 * x 从 86vw 收到 -10vw / 16vw / 112vw，全部横向位移都用左右留白消化；
 * y 最低 84vh，仍在页脚文字之上（页脚 z-index 2，鹤在场景层 z-index 0 内，天然在文字之下）。
 */
export const CRANE_FLIGHT: readonly CraneFlightFrame[] = [
  { at: 0, x: 86, y: 84, rot: 12 },
  { at: 6, x: 73, y: 80, rot: 11 },
  { at: 14, x: 63, y: 70, rot: 9 },
  { at: 24, x: 54, y: 58, rot: 7 },
  { at: 34, x: 42, y: 46, rot: 6 },
  { at: 44, x: 26, y: 36, rot: 5 },
  { at: 52, x: 10, y: 27, rot: 5 },
  { at: 58, x: -10, y: 23, rot: 6 },
  { at: 74, x: 16, y: -20, rot: 9 },
  { at: 88, x: 112, y: 66, rot: 11 },
  { at: 94, x: 98, y: 78, rot: 12 },
  { at: 100, x: 86, y: 84, rot: 12 },
];

/** 外层一圈 36s（要求在 30–50s 内）；可见段 0–58% 约 20.9s 横穿画面 */
export const CRANE_FLIGHT_SECONDS = 36;

/** 内层振翅周期 0.9s（要求在 0.7–1.1s 内） */
export const CRANE_FLAP_SECONDS = 0.9;

export type Point = { x: number; y: number };

/**
 * 一根飞羽：从 base 到 tip 的细长闭合翅片，根部最宽、尖端收成一点。
 * bow 是羽片中段沿法线的弯度（羽尖略外翻，端点参差靠它拉开）。
 */
export function featherPath(base: Point, tip: Point, width: number, bow: number): string {
  const dx = tip.x - base.x;
  const dy = tip.y - base.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const half = width / 2;
  const midX = (base.x + tip.x) / 2;
  const midY = (base.y + tip.y) / 2;
  const outX = midX + nx * bow;
  const outY = midY + ny * bow;
  const inX = midX - nx * bow * 0.55;
  const inY = midY - ny * bow * 0.55;
  const n = (value: number) => +value.toFixed(2);
  return [
    `M${n(base.x + nx * half)} ${n(base.y + ny * half)}`,
    `Q${n(outX)} ${n(outY)} ${n(tip.x)} ${n(tip.y)}`,
    `Q${n(inX)} ${n(inY)} ${n(base.x - nx * half)} ${n(base.y - ny * half)}`,
    "Z",
  ].join(" ");
}

/**
 * 羽片（造型主用版）：根部最宽、向羽尖收窄的楔形，但两侧在前 45% 长度内保持等宽，
 * 之后才向羽尖收，羽尖再留一个 width × tipRatio 的圆头。
 *
 * 两条侧边如果都用「根部 → 中段控制点 → 羽尖」的二次曲线，控制点几乎贴着轴线，
 * 羽片会在离开根部三分之一处就收成细线——那正是前几版把飞羽画成锯齿、
 * 把尾羽画成黑棍的原因。这里改成三次贝塞尔，控制点留在半宽处，羽片才有羽面。
 */
export function bladePath(base: Point, tip: Point, width: number, bow: number, tipRatio = 0.26): string {
  const dx = tip.x - base.x;
  const dy = tip.y - base.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy;
  const ny = ux;
  const half = width / 2;
  const cap = half * tipRatio;
  const at = (along: number, side: number) => ({
    x: base.x + ux * len * along + nx * side,
    y: base.y + uy * len * along + ny * side,
  });
  const a0 = at(0, half);
  const a1 = at(0.42, half + bow);
  const a2 = at(0.86, half * 0.58 + bow * 0.4);
  const a3 = at(1, cap);
  const b1 = at(0.86, -half * 0.58 + bow * 0.4);
  const b2 = at(0.42, -half - bow * 0.15);
  const b3 = at(0, -half);
  const n = (value: number) => +value.toFixed(2);
  return [
    `M${n(a0.x)} ${n(a0.y)}`,
    `C${n(a1.x)} ${n(a1.y)} ${n(a2.x)} ${n(a2.y)} ${n(a3.x)} ${n(a3.y)}`,
    `Q${n(tip.x + ux * cap * 1.1)} ${n(tip.y + uy * cap * 1.1)} ${n(tip.x - nx * cap)} ${n(tip.y - ny * cap)}`,
    `C${n(b1.x)} ${n(b1.y)} ${n(b2.x)} ${n(b2.y)} ${n(b3.x)} ${n(b3.y)}`,
    "Z",
  ].join(" ");
}

export type Feather = { base: Point; tip: Point; width: number; bow: number };

/**
 * 近翼初级飞羽：5 根，羽根沿近翼外段后缘依次排开（间距 8 单位、羽宽 13–14.4，
 * 相邻羽面重叠近半，成一块墨色翼端而不是一把梳子），长度 20.9 → 26.8 递增，
 * 羽尖各自错开 7–9 单位并收圆，外缘只留浅浅的羽间凹口。
 */
export const CRANE_PRIMARIES: readonly Feather[] = [
  { base: { x: 124, y: 97.9 }, tip: { x: 112.4, y: 115.3 }, width: 14.4, bow: 1.3 },
  { base: { x: 116, y: 99.7 }, tip: { x: 103.6, y: 118.4 }, width: 14.2, bow: 1.3 },
  { base: { x: 108, y: 100.3 }, tip: { x: 94.8, y: 120.2 }, width: 13.8, bow: 1.2 },
  { base: { x: 100, y: 99.2 }, tip: { x: 86, y: 120.4 }, width: 13.4, bow: 1.2 },
  { base: { x: 92, y: 95.6 }, tip: { x: 77.2, y: 118 }, width: 12.8, bow: 1.1 },
];

/** 近翼根部叠的 3 根短次级飞羽：只在后缘留三小段羽尖，不探出翼面 */
export const CRANE_SECONDARIES: readonly Feather[] = [
  { base: { x: 140.5, y: 90.5 }, tip: { x: 135, y: 96.5 }, width: 8.6, bow: 0.5 },
  { base: { x: 145, y: 85.5 }, tip: { x: 140, y: 92 }, width: 8.2, bow: 0.5 },
  { base: { x: 147.5, y: 79 }, tip: { x: 143, y: 86 }, width: 7.6, bow: 0.4 },
];

/** 远翼的 3 根初级飞羽：越过翼尖继续向上后方伸，整组压淡 */
export const CRANE_FAR_PRIMARIES: readonly Feather[] = [
  { base: { x: 92, y: 16 }, tip: { x: 72, y: 2 }, width: 6.2, bow: 0.9 },
  { base: { x: 95, y: 27 }, tip: { x: 75, y: 13 }, width: 6, bow: 0.9 },
  { base: { x: 98, y: 38 }, tip: { x: 78, y: 24 }, width: 5.6, bow: 0.8 },
];

/** 尾羽 3 片：几乎完全叠合成一小片楔形尾，只在尾端留两道浅凹口 */
export const CRANE_TAIL: readonly Feather[] = [
  { base: { x: 84, y: 65 }, tip: { x: 63, y: 64 }, width: 10, bow: 0.5 },
  { base: { x: 84, y: 67.5 }, tip: { x: 61.5, y: 67 }, width: 10.4, bow: 0.5 },
  { base: { x: 84, y: 70 }, tip: { x: 63, y: 70 }, width: 10, bow: 0.5 },
];

/** 腿：髋 → 膝 → 踝 三段折线，贴着腹线向后收；脚趾三根分开 */
export const CRANE_LEG: readonly Point[] = [
  { x: 120, y: 75 },
  { x: 96, y: 80 },
  { x: 62, y: 84 },
];

export const CRANE_TOES: readonly [Point, Point][] = [
  [{ x: 62, y: 84 }, { x: 51, y: 83.2 }],
  [{ x: 62, y: 84 }, { x: 52, y: 85.4 }],
  [{ x: 62, y: 84 }, { x: 53, y: 87.4 }],
];

/**
 * 躯干：一条闭合路径。背线从尾根 (74,68) 抬起、肩部前凸到 (137,55)、
 * 胸口在 (152.6,63.4) 圆收、腹部经 (146,79.2)(92,80.2) 回收到尾根。
 * 长 83.8、高 28.6（约 2.9:1），尾端收成楔形、胸口最鼓，是水滴形而不是椭圆。
 */
export const CRANE_BODY =
  "M74 68 C86 61.4 105 56.4 123 55.4 C137 54.8 148 57.6 152.6 63.4 " +
  "C155.8 68.6 153 75 146 79.2 C134 85.8 106 85.8 92 80.2 C82 76.6 72 71.8 74 68 Z";

/** 腹面阴影：与躯干下缘同曲率的一条窄带，交代腹部圆收 */
export const CRANE_BELLY =
  "M86 77.6 C100 84 122 84.6 140 77.6 C140.8 79.6 136 82 129 83.4 " +
  "C113 86 96 84.4 88 80.6 C86.4 79.6 85.4 78.4 86 77.6 Z";

/** 体侧羽面：贴着背线的一条冷灰窄带，把背线与侧腹分开 */
export const CRANE_FLANK = "M130 56.4 C112 59 94 64 82 70.4 C96 71 113 66.6 128 60 Z";

/**
 * 颈：独立 S 形闭合路径，四段走向 →
 * 肩侧陡起 (145,56)→(169,43.6)；中段外凸到 (195,41.8)；近头转平到 (210.4,43)；
 * 喉侧内凹 (187,51.6) 收进胸口 (159,62.6)。根部两端都压在躯干轮廓之内，
 * 由躯干（z 5 > z 4）盖住，不是贴上去的。
 */
export const CRANE_NECK =
  "M145 56 C156 48.4 169 43.6 183 41.8 C195 40.2 205 40.6 210.4 43 " +
  "L210.8 50.2 C203.4 48.8 195 49.8 187 51.6 C177 53.8 167 57.4 159 62.6 " +
  "C151 61.4 147 59.4 145 56 Z";

/** 颈后结构转折线：顺着颈背的 S 形落到肩，交代颈的转向 */
export const CRANE_NAPE = "M209 40.8 C197 39.8 186 41.8 177 45.6 C168 49.2 160 53.4 154 58.2";

/** 头：正面偏侧，圆颅 */
export const CRANE_HEAD =
  "M208.4 44 C208.4 38 211.6 34.8 216 34.8 C220.4 34.8 223.6 38 223.6 44 " +
  "C223.6 50 220.4 53.2 216 53.2 C211.6 53.2 208.4 50 208.4 44 Z";

/** 喙：从颅前 (222,42.2) 起，尖端 (238.8,40) 略上扬，上下缘收成一点 */
export const CRANE_BEAK =
  "M222 42.2 C227.6 40.8 233.4 39.6 238.2 38.6 C239.4 38.4 239.8 39.2 238.8 40 " +
  "C234 43.4 228.4 46 222.4 47.6 C221.4 46 221.2 43.6 222 42.2 Z";

/** 顶冠：贴着颅顶的一小块朱红，前缘压到喙基部 */
export const CRANE_CROWN =
  "M210.4 40.4 C210.8 36.4 213 34.4 216 34.4 C219 34.4 221.4 36.4 222.4 39.6 " +
  "C219 37.8 214 38 210.4 40.4 Z";

/** 眼位 */
export const CRANE_EYE = { x: 217.4, y: 45.4, r: 1.5 } as const;

/**
 * 近翼翼面（闭合，只填色不描边）：翼根 (148,60)-(149,74) 最宽，沿前缘经 (104,86)
 * 收到翼尖 (90,92)，后缘从翼尖经 (112,101)(126,97) 回到翼根，是一块楔形而不是圆片。
 * 翼根那条边压在躯干上，所以这条闭合路径不描边，描边交给下面的 CRANE_NEAR_WING_EDGE。
 */
export const CRANE_NEAR_WING =
  "M148 60 C136 68 120 78 104 86 C98 89 93 91 90 92 " +
  "C98 98 112 101 126 97 C138 93 148 86 149 74 C150 68 150 63 148 60 Z";

/** 近翼外轮廓（开放路径，只描边）：前缘 → 翼尖 → 后缘，翼根处不封口 */
export const CRANE_NEAR_WING_EDGE =
  "M148 60 C136 68 120 78 104 86 C98 89 93 91 90 92 C98 98 112 101 126 97 C138 93 148 86 149 74";

/** 近翼覆羽分区线：两道路径，把翼根覆羽与飞羽区分开 */
export const CRANE_COVERTS = ["M149 66 C139 72 126 80 113 87", "M150 72 C142 78 130 86 118 92"] as const;

/**
 * 远翼翼面：从肩点向上后方展开，翼尖在 (91,13)。
 * 翼根两端落在躯干轮廓内（(142,53) 与 (150,70)），由躯干（z 5 > z 2）盖住，
 * 所以远翼只在翼根与躯干相交处被遮挡。
 */
export const CRANE_FAR_WING =
  "M142 53 C129 33 111 19 91 13 C85 28 89 42 98 49 C111 57 133 62 150 70 Z";

/** 远翼翼轴：从翼根顺着翼面向翼尖的一道结构线 */
export const CRANE_FAR_WING_SHAFT = "M141 52 C128 32 110 19 92 14";

/** 两翼摆动的幅度（deg）：内层同一个周期，近翼小幅、远翼稍大，读起来是一次完整的振翅 */
export const CRANE_FLAP = {
  near: { from: -7, to: 6 },
  far: { from: -5, to: 10 },
} as const;

/** 飞行包裹盒（视口百分比）：用于验收越界与页脚重叠，不做动画 */
export function craneFlightEnvelope(frames: readonly CraneFlightFrame[] = CRANE_FLIGHT) {
  const xs = frames.map((frame) => frame.x);
  const ys = frames.map((frame) => frame.y);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}
