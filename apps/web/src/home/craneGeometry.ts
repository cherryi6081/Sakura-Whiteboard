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
  /** 只用来在「入画前 / 出画后」把鹤藏起来，避免看到它在画面里瞬移回起点 */
  opacity: number;
};

/**
 * 飞行关键帧（与 pages.css 的 @keyframes wb-crane-flight 一一对应，单测会比对）。
 *
 * 一条单向航路：从右下角入画，向左上掠过山体，从左侧上方出画；出画后整只鹤
 * opacity 归零，在不可见状态下沿原路折回起点，下一次循环再从右下角淡入。
 * 这样不会出现上一版「在画面外绕一圈又从右边穿回来」的掉头，也不会有可见的瞬移。
 * 0% 与 100% 的位置、角度、透明度完全相同，循环处不跳帧。
 *
 * x 从 108vw 收到 -24vw，y 从 88vh 升到 8vh；0–2% 藏在视口右下角外侧且全透明，
 * 等升到 85.5vh 以上才开始淡入，所以真正可见时 y 最低 82vh（淡入中途 83.75vh），
 * 底部仍在页脚文字（约 93.8vh）之上。
 */
export const CRANE_FLIGHT: readonly CraneFlightFrame[] = [
  { at: 0, x: 108, y: 88, rot: 13, opacity: 0 },
  { at: 2, x: 104, y: 85.5, rot: 13, opacity: 0 },
  { at: 4, x: 98, y: 82, rot: 13, opacity: 1 },
  { at: 10, x: 86, y: 78, rot: 12, opacity: 1 },
  { at: 18, x: 73, y: 69, rot: 10, opacity: 1 },
  { at: 28, x: 58, y: 57, rot: 8, opacity: 1 },
  { at: 38, x: 43, y: 45, rot: 6, opacity: 1 },
  { at: 48, x: 28, y: 34, rot: 5, opacity: 1 },
  { at: 58, x: 13, y: 24, rot: 5, opacity: 1 },
  { at: 68, x: -2, y: 16, rot: 6, opacity: 1 },
  { at: 76, x: -16, y: 10, rot: 8, opacity: 1 },
  { at: 80, x: -24, y: 8, rot: 9, opacity: 0 },
  { at: 100, x: 108, y: 88, rot: 13, opacity: 0 },
];

/** 外层一圈 36s（要求在 30–50s 内）；可见段 0–80% 约 28.8s 从右下穿到左上 */
export const CRANE_FLIGHT_SECONDS = 36;

/** 后一只鹤比前一只晚 3s 起飞（要求在 1.5–3s 内）；用负延时实现，加载时它正处在上圈的不可见段 */
export const CRANE_TRAIL_DELAY_SECONDS = 3;

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
 * 羽片（造型主用版）：一条完整的闭合羽面，两侧各一段三次贝塞尔，羽尖用一段
 * 二次曲线收成圆头，没有一处折线拐点。
 *
 * 轮廓规律：根部宽度 width × 0.92 → 30% 处最厚（width × 1.04 + bow）→ 78% 处收到
 * 六成 → 羽尖留一个半宽 × tipRatio 的圆头。「渐变收尖」靠这两段 C 曲线的控制点
 * 拉开，而不是靠一条斜直线，所以放大后边缘仍然是光滑的。
 *
 * 相邻羽片不留缝由数据保证：同组羽片根部间距小于羽宽、尖端间距小于两个圆头
 * 半径之和，叠起来是一块连续羽面，只在羽尖之间留很浅的凹口。
 */
export function bladePath(base: Point, tip: Point, width: number, bow: number, tipRatio = 0.42): string {
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
  const a0 = at(0, half * 0.92);
  const a1 = at(0.3, half * 1.04 + bow);
  const a2 = at(0.78, half * 0.62 + bow * 0.75);
  const a3 = at(0.985, cap);
  const b1 = at(0.78, -half * 0.62 - bow * 0.2);
  const b2 = at(0.3, -half * 0.98 - bow * 0.1);
  const b3 = at(0, -half * 0.92);
  const n = (value: number) => +value.toFixed(3);
  return [
    `M${n(a0.x)} ${n(a0.y)}`,
    `C${n(a1.x)} ${n(a1.y)} ${n(a2.x)} ${n(a2.y)} ${n(a3.x)} ${n(a3.y)}`,
    `Q${n(tip.x + ux * cap * 0.6)} ${n(tip.y + uy * cap * 0.6)} ${n(tip.x - nx * cap)} ${n(
      tip.y - ny * cap,
    )}`,
    `C${n(b1.x)} ${n(b1.y)} ${n(b2.x)} ${n(b2.y)} ${n(b3.x)} ${n(b3.y)}`,
    "Z",
  ].join(" ");
}

export type Feather = { base: Point; tip: Point; width: number; bow: number };

/**
 * 近翼初级飞羽：5 根，羽根沿近翼外段后缘依次排开（间距 5.4 单位、羽宽 14.8–16.8，
 * 相邻羽面重叠六成以上），羽尖沿一条平缓的弧线排开、间距 6.6（小于两个圆头半径之和
 * 6.8），所以整组是一块连续墨色翼端，只在羽尖之间留几处很浅的凹口。
 * 长度 19.8 → 24.1 递增，羽尖逐个外错，靠近身体的一根最长。
 */
export const CRANE_PRIMARIES: readonly Feather[] = [
  { base: { x: 124.5, y: 96.2 }, tip: { x: 114.8, y: 113.6 }, width: 16.8, bow: 1.4 },
  { base: { x: 119.1, y: 98.4 }, tip: { x: 108.6, y: 115.9 }, width: 16.4, bow: 1.4 },
  { base: { x: 113.6, y: 99.6 }, tip: { x: 102.2, y: 117.6 }, width: 16, bow: 1.3 },
  { base: { x: 107.9, y: 99.6 }, tip: { x: 95.6, y: 118.4 }, width: 15.4, bow: 1.3 },
  { base: { x: 102, y: 98.2 }, tip: { x: 88.9, y: 118.2 }, width: 14.8, bow: 1.2 },
];

/** 近翼根部叠的 3 根短次级飞羽：只在后缘露出两三单位的小羽尖，不探出翼面 */
export const CRANE_SECONDARIES: readonly Feather[] = [
  { base: { x: 140.5, y: 90.5 }, tip: { x: 136.5, y: 94 }, width: 8.6, bow: 0.5 },
  { base: { x: 145, y: 85.5 }, tip: { x: 141.5, y: 90.5 }, width: 8.2, bow: 0.5 },
  { base: { x: 147.5, y: 79 }, tip: { x: 144.5, y: 85 }, width: 7.6, bow: 0.4 },
];

/**
 * 远翼的 4 根初级飞羽：越过翼尖继续向上后方伸。与近翼同一支墨色（--crane-ink），
 * 不再用「墨色 × 半透明」压淡——那正是上一版远翼羽尖发灰的原因。
 * 深度差改由翼面本身的冷灰调承担。羽根藏在翼面之下，羽尖间距 5.6–5.8
 * 小于两个圆头半径 8.4，叠成一块连续的深色翼尖。
 */
export const CRANE_FAR_PRIMARIES: readonly Feather[] = [
  { base: { x: 92, y: 22 }, tip: { x: 76, y: 7 }, width: 15, bow: 1.5 },
  { base: { x: 94, y: 27 }, tip: { x: 74.8, y: 12.6 }, width: 15.4, bow: 1.5 },
  { base: { x: 96, y: 32 }, tip: { x: 75.2, y: 18.2 }, width: 15.2, bow: 1.4 },
  { base: { x: 98, y: 37 }, tip: { x: 76.6, y: 23.8 }, width: 14.6, bow: 1.3 },
];

/**
 * 尾羽 3 片：羽根叠在一起、向尾端收成一片短楔形，羽尖中间最长、上下两片略短，
 * 所以尾端是圆弧而不是一条平切的横边；两处凹口都很浅。
 * bow 拉到 1.8，上下两条边都带弧，避免读成一块矩形。
 */
export const CRANE_TAIL: readonly Feather[] = [
  { base: { x: 84, y: 63.5 }, tip: { x: 64, y: 63 }, width: 13.6, bow: 1.8 },
  { base: { x: 84, y: 67.8 }, tip: { x: 61.5, y: 68 }, width: 14, bow: 1.8 },
  { base: { x: 84, y: 72.1 }, tip: { x: 64, y: 73 }, width: 13.6, bow: 1.8 },
];

/**
 * 近侧腿（画在上层、更靠外更低）：髋 → 膝 → 踝 三段折线，贴着腹线向后收；
 * 脚趾三根分开。
 */
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
 * 远侧腿：透视更小更短——髋点略高且更靠内（x 118 vs 120），踝点从 62 收到 74，
 * 整条腿短 10 单位、抬 3 单位，脚趾也短一档；由 CSS 的 `.wb-crane__leg--far`
 * 再压到 0.72 不透明度，读成被身体挡住的另一条腿。
 */
export const CRANE_FAR_LEG: readonly Point[] = [
  { x: 118, y: 73.4 },
  { x: 101, y: 77.4 },
  { x: 74, y: 80.6 },
];

export const CRANE_FAR_TOES: readonly [Point, Point][] = [
  [{ x: 74, y: 80.6 }, { x: 64.4, y: 79.9 }],
  [{ x: 74, y: 80.6 }, { x: 65.2, y: 81.9 }],
  [{ x: 74, y: 80.6 }, { x: 66, y: 83.6 }],
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
