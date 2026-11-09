import type { CSSProperties } from "react";

/**
 * 首页整页场景：富士山全景 + 右侧樱花枝 + 曲线飘散花瓣 + 两只仙鹤。
 *
 * 实现选择：花瓣与鹤都用 **纯 CSS 多关键帧 transform/opacity**，不用 canvas。
 * 理由：元素数量有限（桌面 26 片花瓣 + 2 只鹤），CSS 动画由合成器在 GPU 上推进，
 * 不占主线程、也不需要 rAF 常驻循环；canvas 在这个量级反而要自管 DPR、清理与
 * prefers-reduced-motion，收益不大。代价是路径在 CSS 里写死，靠 `path` 变体
 * + 每个元素的时长/延迟/旋转系数制造差异，避免 26 段重复关键帧。
 *
 * 轨迹：A 向左下弧线、B 向右下弧线、C 先右后左的 S 弧。每段用不同
 * `animation-timing-function`（起步 ease-in → 中段 ease-in-out → 末段 ease-in），
 * 模拟风推 + 重力加速；旋转角度按 `--p-spin` 逐片放大，避免整齐划一。
 */

type PetalPath = "a" | "b" | "c";
type PetalTone = "light" | "mid" | "deep";

type Petal = {
  /** 起点水平位置（%） */
  left: number;
  /** 起点垂直位置（%），负数从画面上方进入 */
  top: number;
  /** 花瓣宽度（px） */
  size: number;
  /** 飘散周期（s） */
  dur: number;
  /** 负延迟让首屏已经散布在空中 */
  delay: number;
  /** 旋转系数，逐片不同 */
  spin: number;
  opacity: number;
  tone: PetalTone;
  path: PetalPath;
};

const PETALS: Petal[] = [
  // 画面上方进入的：横跨全景缓慢飘落
  { left: 6, top: -6, size: 13, dur: 24, delay: -9, spin: 0.8, opacity: 0.42, tone: "light", path: "a" },
  { left: 14, top: -12, size: 18, dur: 20, delay: -3, spin: 1.1, opacity: 0.72, tone: "mid", path: "b" },
  { left: 22, top: -4, size: 12, dur: 26, delay: -14, spin: 0.7, opacity: 0.36, tone: "light", path: "c" },
  { left: 31, top: -14, size: 16, dur: 18, delay: -7, spin: 1.2, opacity: 0.66, tone: "deep", path: "a" },
  { left: 39, top: -2, size: 21, dur: 16, delay: -1, spin: 1, opacity: 0.8, tone: "mid", path: "b" },
  { left: 47, top: -9, size: 14, dur: 23, delay: -11, spin: 0.75, opacity: 0.5, tone: "light", path: "a" },
  { left: 55, top: -15, size: 17, dur: 21, delay: -5, spin: 1.15, opacity: 0.6, tone: "mid", path: "c" },
  { left: 63, top: -10, size: 12, dur: 25, delay: -17, spin: 0.85, opacity: 0.38, tone: "light", path: "b" },
  { left: 71, top: -3, size: 19, dur: 17, delay: -2, spin: 1.05, opacity: 0.74, tone: "deep", path: "a" },
  // 右侧樱花枝附近的：起势更靠近枝头，向左下散开
  { left: 66, top: 9, size: 15, dur: 19, delay: -12, spin: 1.1, opacity: 0.62, tone: "mid", path: "a" },
  { left: 72, top: 4, size: 22, dur: 15, delay: -4, spin: 0.9, opacity: 0.86, tone: "mid", path: "c" },
  { left: 78, top: 13, size: 13, dur: 22, delay: -19, spin: 1.3, opacity: 0.48, tone: "light", path: "a" },
  { left: 83, top: 6, size: 18, dur: 18, delay: -8, spin: 1, opacity: 0.78, tone: "deep", path: "a" },
  { left: 88, top: 16, size: 16, dur: 20, delay: -2, spin: 1.2, opacity: 0.68, tone: "mid", path: "c" },
  { left: 92, top: 8, size: 24, dur: 14, delay: -6, spin: 0.85, opacity: 0.9, tone: "mid", path: "a" },
  { left: 97, top: 3, size: 15, dur: 21, delay: -16, spin: 1.25, opacity: 0.55, tone: "light", path: "a" },
  { left: 74, top: 22, size: 12, dur: 26, delay: -21, spin: 0.95, opacity: 0.4, tone: "light", path: "b" },
  { left: 81, top: 26, size: 17, dur: 17, delay: -10, spin: 1.15, opacity: 0.7, tone: "mid", path: "c" },
  { left: 87, top: 21, size: 14, dur: 23, delay: -14, spin: 1, opacity: 0.58, tone: "deep", path: "a" },
  { left: 94, top: 24, size: 20, dur: 16, delay: -1, spin: 1.1, opacity: 0.82, tone: "deep", path: "a" },
  { left: 99, top: 18, size: 13, dur: 25, delay: -18, spin: 0.8, opacity: 0.45, tone: "light", path: "c" },
  { left: 68, top: 31, size: 11, dur: 28, delay: -23, spin: 1.2, opacity: 0.34, tone: "light", path: "a" },
  { left: 76, top: 34, size: 16, dur: 19, delay: -13, spin: 1.05, opacity: 0.64, tone: "mid", path: "c" },
  { left: 84, top: 37, size: 13, dur: 24, delay: -5, spin: 0.9, opacity: 0.52, tone: "light", path: "a" },
  { left: 91, top: 32, size: 18, dur: 17, delay: -15, spin: 1.15, opacity: 0.72, tone: "mid", path: "a" },
  { left: 96, top: 40, size: 15, dur: 22, delay: -7, spin: 1, opacity: 0.6, tone: "deep", path: "b" },
];

type Crane = {
  className: string;
  /** 剪影宽度（px） */
  size: number;
  /** 全程飞行时长（s），刻意放慢 */
  dur: number;
  /** 负延迟让首屏不是两只一起从右下角起飞 */
  delay: number;
  opacity: number;
  /** 路径四段的纵向位置（vh）：右下画外 → 上扬弧 → 左上画外 */
  y0: string;
  y1: string;
  y2: string;
  y3: string;
  /** 上下起伏周期（s） */
  bob: number;
  /** 振翅周期（s） */
  flap: number;
};

const CRANES: Crane[] = [
  {
    className: "wb-crane--one",
    size: 138,
    dur: 38,
    delay: -7,
    opacity: 0.9,
    y0: "80vh",
    y1: "58vh",
    y2: "32vh",
    y3: "6vh",
    bob: 3.4,
    flap: 3.2,
  },
  {
    className: "wb-crane--two",
    size: 104,
    dur: 47,
    delay: -28,
    opacity: 0.78,
    y0: "70vh",
    y1: "46vh",
    y2: "20vh",
    y3: "-2vh",
    bob: 4.2,
    flap: 3.9,
  },
];

/** 夜空星点：[x, y, r, opacity]，静态，不做闪烁动画 */
const STARS: Array<[number, number, number, number]> = [
  [90, 60, 1.6, 0.7],
  [240, 140, 2, 0.55],
  [368, 84, 1.2, 0.4],
  [520, 44, 1.4, 0.65],
  [612, 176, 1.8, 0.5],
  [728, 96, 1.1, 0.35],
  [846, 48, 1.5, 0.6],
  [998, 128, 2.2, 0.5],
  [1104, 62, 1.3, 0.4],
  [1230, 158, 1.9, 0.55],
  [1352, 88, 1.2, 0.38],
  [1478, 46, 1.7, 0.62],
  [1560, 132, 1.4, 0.45],
  [164, 236, 1.2, 0.3],
  [644, 262, 1.5, 0.34],
  [1150, 246, 1.3, 0.3],
  [1410, 220, 1.8, 0.36],
  [300, 318, 1.1, 0.26],
  [762, 330, 1.3, 0.24],
  [1320, 312, 1.5, 0.28],
];

/**
 * 枝条分段：每段是一条**纯直线折线**（只用 M / L，不用任何贝塞尔），
 * 段内保留拐点，所以转折处是硬角；同一根枝由粗到细拆成 2–5 段，
 * 每段给一个更细的 strokeWidth，靠 butt 端点直接衔接模拟收细。
 * 角度按现实生长：主干自画面边缘斜插进来，分叉一律锐角。
 */
type BranchSegment = { d: string; width: number };

/** 前景主枝组：主干 + 六根侧枝 + 六根末梢短枝 */
const MAIN_BRANCHES: BranchSegment[] = [
  // 主干：右侧画外 → 左上折 → 转左下，一路带硬转折
  { d: "M522 28 L452 52 L404 88", width: 13 },
  { d: "M404 88 L372 112 L340 168", width: 11 },
  { d: "M340 168 L318 206 L300 266", width: 8.8 },
  { d: "M300 266 L296 330 L302 392", width: 6.6 },
  { d: "M302 392 L312 452 L324 502", width: 4.6 },
  { d: "M324 502 L344 556 L366 606", width: 3 },
  { d: "M366 606 L372 640 L368 678", width: 1.8 },
  // 上侧横枝：向左铺开，每个拐点都换角度
  { d: "M372 112 L320 92 L270 76 L226 74", width: 6.8 },
  { d: "M226 74 L182 92 L140 106 L104 118", width: 4.2 },
  // 上斜短枝
  { d: "M188 86 L164 66 L140 54 L116 48", width: 2.2 },
  // 中段左枝
  { d: "M344 150 L300 134 L258 132 L222 146", width: 5.4 },
  { d: "M222 146 L188 160 L156 180 L134 200", width: 3 },
  // 右上短枝
  { d: "M318 212 L352 196 L392 180 L430 178", width: 5 },
  { d: "M430 178 L452 182 L472 188", width: 2.4 },
  // 左下长枝
  { d: "M298 300 L266 318 L232 338 L196 362", width: 5 },
  { d: "M196 362 L168 386 L142 412 L130 434", width: 2.8 },
  // 右下长枝
  { d: "M302 372 L324 404 L352 440 L374 472", width: 4.2 },
  { d: "M374 472 L388 500 L392 530 L390 554", width: 2.2 },
  // 主干上的末梢短枝（越靠下越短、越细）
  { d: "M312 466 L320 496 L330 518", width: 2 },
  { d: "M348 546 L352 562", width: 1.4 },
  { d: "M232 80 L200 56 L172 38", width: 2.4 },
  { d: "M304 268 L272 290 L240 316", width: 3 },
  { d: "M268 148 L238 172 L214 202", width: 2.8 },
  { d: "M424 200 L430 228 L434 258", width: 2 },
  // 两根更小的末梢分枝
  { d: "M300 296 L284 284", width: 1.8 },
  { d: "M352 440 L370 428", width: 1.6 },
];

/** 背景枯枝：更细更淡，同样用折线，垫在前景枝之后 */
const FAR_BRANCHES: BranchSegment[] = [
  { d: "M522 128 L470 130 L420 142 L396 152", width: 3 },
  { d: "M396 152 L350 178 L310 202 L286 226", width: 2.2 },
  { d: "M472 236 L420 236 L374 248 L344 262", width: 2.6 },
  { d: "M344 262 L308 284 L282 306 L262 324", width: 1.8 },
  { d: "M522 336 L480 354 L450 378 L432 404", width: 2.4 },
  { d: "M432 404 L414 436 L404 466", width: 1.7 },
];

type BlossomKind = "bud" | "half" | "full";

/** 花朵：x/y 为花心坐标，size 为花瓣长度，rot 为朝向 */
type Blossom = { x: number; y: number; size: number; rot: number; kind: BlossomKind };

/** 沿各枝梢成簇布置：每簇 2–3 朵，花心贴着枝梢（离枝线 2–8 单位），不串成一条珠链 */
const BLOSSOMS: Blossom[] = [
  // 左上细梢
  { x: 113, y: 42, size: 12, rot: 12, kind: "full" },
  { x: 125, y: 56, size: 9, rot: -34, kind: "half" },
  { x: 102, y: 40, size: 8, rot: 44, kind: "bud" },
  // 横枝末端
  { x: 104, y: 112, size: 13, rot: -14, kind: "full" },
  { x: 115, y: 127, size: 9, rot: 28, kind: "bud" },
  { x: 91, y: 124, size: 10, rot: 58, kind: "half" },
  { x: 169, y: 89, size: 13, rot: 22, kind: "full" },
  { x: 182, y: 103, size: 9, rot: -40, kind: "bud" },
  { x: 157, y: 101, size: 11, rot: 64, kind: "half" },
  // 新补的上斜梢
  { x: 174, y: 34, size: 11, rot: 16, kind: "full" },
  { x: 186, y: 47, size: 8, rot: -22, kind: "bud" },
  // 中段左枝末端
  { x: 141, y: 187, size: 13, rot: -8, kind: "full" },
  { x: 154, y: 202, size: 9, rot: 34, kind: "bud" },
  { x: 129, y: 204, size: 10, rot: 60, kind: "half" },
  // 下斜短梢
  { x: 213, y: 199, size: 10, rot: -16, kind: "full" },
  { x: 224, y: 214, size: 7, rot: 40, kind: "bud" },
  // 中段左枝起点
  { x: 224, y: 139, size: 11, rot: 18, kind: "full" },
  { x: 237, y: 154, size: 8, rot: -26, kind: "bud" },
  // 左下短梢
  { x: 239, y: 312, size: 10, rot: 30, kind: "full" },
  { x: 250, y: 325, size: 7, rot: -44, kind: "bud" },
  // 右上短枝末端
  { x: 469, y: 181, size: 12, rot: 10, kind: "full" },
  { x: 480, y: 196, size: 8, rot: -36, kind: "bud" },
  { x: 455, y: 196, size: 10, rot: 44, kind: "half" },
  { x: 405, y: 170, size: 10, rot: -18, kind: "full" },
  // 右上下垂短梢
  { x: 434, y: 254, size: 9, rot: 22, kind: "full" },
  { x: 441, y: 268, size: 7, rot: -30, kind: "bud" },
  // 主干入口
  { x: 440, y: 55, size: 13, rot: 16, kind: "full" },
  { x: 428, y: 78, size: 9, rot: -30, kind: "bud" },
  { x: 455, y: 84, size: 11, rot: 52, kind: "half" },
  // 主干中段旁
  { x: 384, y: 100, size: 11, rot: 24, kind: "full" },
  { x: 374, y: 117, size: 8, rot: -38, kind: "bud" },
  // 左下长枝末端
  { x: 130, y: 424, size: 13, rot: -10, kind: "full" },
  { x: 142, y: 439, size: 9, rot: 30, kind: "bud" },
  { x: 117, y: 441, size: 10, rot: 62, kind: "half" },
  { x: 193, y: 355, size: 11, rot: 14, kind: "full" },
  { x: 208, y: 369, size: 8, rot: -24, kind: "bud" },
  // 右下长枝末端
  { x: 390, y: 545, size: 13, rot: 8, kind: "full" },
  { x: 402, y: 559, size: 8, rot: -36, kind: "bud" },
  { x: 375, y: 561, size: 10, rot: 48, kind: "half" },
  { x: 371, y: 465, size: 11, rot: -6, kind: "full" },
  // 主干后段
  { x: 328, y: 511, size: 10, rot: 20, kind: "full" },
  { x: 342, y: 526, size: 8, rot: -30, kind: "bud" },
  { x: 350, y: 555, size: 11, rot: 44, kind: "full" },
  { x: 366, y: 669, size: 12, rot: 12, kind: "full" },
  { x: 379, y: 686, size: 8, rot: -38, kind: "bud" },
];

/** 背景枝梢上的几朵：整体压暗一档，用来交代前后层次 */
const FAR_BLOSSOMS: Blossom[] = [
  { x: 292, y: 222, size: 11, rot: -20, kind: "full" },
  { x: 282, y: 238, size: 7, rot: 36, kind: "bud" },
  { x: 263, y: 318, size: 10, rot: 14, kind: "half" },
  { x: 436, y: 398, size: 9, rot: -28, kind: "full" },
  { x: 402, y: 470, size: 10, rot: 30, kind: "half" },
];

/** 单瓣：单位长度 1，上端收圆、中间带樱花特有的小缺口，下端收到花心 */
const PETAL_PATH =
  "M0 0 C -0.32 -0.18 -0.56 -0.44 -0.5 -0.74 C -0.46 -0.93 -0.3 -1 -0.17 -0.95 L 0 -0.8 L 0.17 -0.95 C 0.3 -1 0.46 -0.93 0.5 -0.74 C 0.56 -0.44 0.32 -0.18 0 0 Z";

/** 花苞：水滴形外壳 + 一点高光 + 两片花萼 */
const BUD_PATH =
  "M0 0 C -0.42 -0.18 -0.56 -0.5 -0.44 -0.78 C -0.34 -1 -0.12 -1.08 0 -1.02 C 0.12 -1.08 0.34 -1 0.44 -0.78 C 0.56 -0.5 0.42 -0.18 0 0 Z";
const CALYX_PATH = "M0 0 C -0.26 -0.02 -0.34 -0.18 -0.26 -0.38 C -0.14 -0.24 0 -0.16 0 0 Z";

/** 一朵樱花：五瓣花冠 + 花芯 + 花蕊；half 只张 3 瓣，bud 用花苞壳 */
function BlossomMark({ x, y, size, rot, kind }: Blossom) {
  const scale = kind === "bud" ? 0.78 : kind === "half" ? 0.9 : 1;
  return (
    <g className="wb-scene__blossom" transform={`translate(${x} ${y}) rotate(${rot}) scale(${size * scale})`}>
      {kind === "bud" ? (
        <>
          <path className="wb-scene__bud" d={BUD_PATH} />
          <ellipse className="wb-scene__bud-light" cx="-0.16" cy="-0.62" rx="0.16" ry="0.26" transform="rotate(-24 -0.16 -0.62)" />
          <path className="wb-scene__blossom-calyx" d={CALYX_PATH} />
          <path className="wb-scene__blossom-calyx" d={CALYX_PATH} transform="scale(-1 1)" />
        </>
      ) : (
        <>
          {(kind === "full" ? [0, 72, 144, 216, 288] : [-58, 0, 58]).map((deg, index) => (
            <path
              // 花瓣按角度定位，角度值本身是唯一 key
              key={deg}
              className={
                index === 0
                  ? "wb-scene__bloom-petal wb-scene__bloom-petal--light"
                  : index % 2 === 1
                    ? "wb-scene__bloom-petal wb-scene__bloom-petal--shade"
                    : "wb-scene__bloom-petal"
              }
              d={PETAL_PATH}
              transform={`rotate(${deg})`}
            />
          ))}
          <circle className="wb-scene__blossom-eye" r="0.28" />
          {(kind === "full" ? [36, 108, 180, 252, 324] : [90, 210, 330]).map((deg) => (
            <circle className="wb-scene__blossom-stamen" key={deg} cx="0" cy="-0.42" r="0.08" transform={`rotate(${deg})`} />
          ))}
        </>
      )}
    </g>
  );
}

function petalStyle(petal: Petal): CSSProperties {
  return {
    "--p-top": `${petal.top}%`,
    "--p-left": `${petal.left}%`,
    "--p-size": `${petal.size}px`,
    "--p-dur": `${petal.dur}s`,
    "--p-delay": `${petal.delay}s`,
    "--p-spin": petal.spin,
    "--p-opacity": petal.opacity,
  } as CSSProperties;
}

function craneStyle(crane: Crane): CSSProperties {
  return {
    "--c-size": `${crane.size}px`,
    "--c-dur": `${crane.dur}s`,
    "--c-delay": `${crane.delay}s`,
    "--c-opacity": crane.opacity,
    "--c-y0": crane.y0,
    "--c-y1": crane.y1,
    "--c-y2": crane.y2,
    "--c-y3": crane.y3,
    "--c-bob": `${crane.bob}s`,
    "--c-flap": `${crane.flap}s`,
  } as CSSProperties;
}

/**
 * 仙鹤剪影：长颈前伸、长腿后摆、宽翼展开；翅膀与身体分组，
 * 翅膀绕肩点小幅 rotate 产生振翅，外层再叠一层 translateY 起伏。
 */
function CraneSilhouette() {
  return (
    <svg className="wb-crane__svg" viewBox="0 0 120 72" focusable="false">
      <g className="wb-crane__wing wb-crane__wing--far">
        <path d="M52 32 C 44 18 34 8 18 4 C 27 18 33 28 42 35 Z" />
      </g>
      <g className="wb-crane__wing wb-crane__wing--near">
        <path d="M52 35 C 46 49 37 61 22 66 C 30 52 34 43 44 35 Z" />
      </g>
      <path
        className="wb-crane__body"
        d="M30 40 C 34 32 46 29 57 31 C 64 33 68 37 63 40 C 55 45 41 46 31 43 Z"
      />
      <path className="wb-crane__body" d="M58 30 C 70 25 82 22 90 20 L 94 23 C 86 28 73 33 64 37 Z" />
      <circle className="wb-crane__body" cx="94" cy="21" r="4.2" />
      <path className="wb-crane__beak" d="M98 19 L 111 18 L 98 22 Z" />
      <circle className="wb-crane__crown" cx="94" cy="17.4" r="2" />
      <path className="wb-crane__leg" d="M32 42 L 8 51" />
      <path className="wb-crane__leg" d="M34 44 L 11 57" />
    </svg>
  );
}

export function FujiScene() {
  return (
    <div className="wb-home__scene" aria-hidden="true">
      {/* 星点单独一层铺满视口：不跟山体一起缩放，窄屏也不会被压进山脚 */}
      <svg className="wb-scene__stars" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice" focusable="false">
        {STARS.map(([cx, cy, r, opacity], index) => (
          // 星点仅用于装饰，index 作为稳定 key
          // eslint-disable-next-line react/no-array-index-key
          <circle className="wb-scene__star" key={index} cx={cx} cy={cy} r={r} opacity={opacity} />
        ))}
      </svg>
      {/* 山体：meet 保证整个轮廓完整可见（山峰、左右山脚、山脚到底部），
          多余天空由底层 CSS 渐变铺满，不出现留白 */}
      <svg className="wb-scene__mountains" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMax meet" focusable="false">
        {/* 远山：最淡的一层，压在所有山体之后 */}
        <path
          className="wb-scene__range-far"
          d="M0 618 L110 540 L210 586 L330 496 L460 580 L600 512 L720 592 L820 546 L940 610 L1060 540 L1190 598 L1300 552 L1420 606 L1600 566 L1600 900 L0 900 Z"
        />
        {/* 中层山脊：右侧略高，托住主峰右坡 */}
        <path
          className="wb-scene__range-mid"
          d="M0 702 L150 620 L280 672 L420 596 L560 668 L700 606 L840 664 L980 600 L1120 668 L1260 612 L1400 676 L1600 620 L1600 900 L0 900 Z"
        />
        {/* 左侧伴峰：低矮一座，制造前后层次 */}
        <path
          className="wb-scene__peak-left"
          d="M180 900 C 240 760 292 660 330 520 C 350 470 360 440 376 410 C 398 470 412 540 440 640 C 480 760 520 840 560 900 Z"
        />
        {/* 山脚雾带：把主峰底座与远山衔接，不整页模糊 */}
        <ellipse className="wb-scene__haze" cx="700" cy="642" rx="470" ry="40" />
        <ellipse className="wb-scene__haze" cx="1240" cy="668" rx="320" ry="34" />
        {/* 主峰：左右内凹的火山轮廓，峰顶略偏右避开左侧文案 */}
        <path
          className="wb-scene__fuji"
          d="M470 900 C 560 780 700 640 820 360 C 848 300 862 250 880 196 C 898 250 912 300 940 360 C 1060 640 1200 780 1290 900 Z"
        />
        {/* 右侧阴影面：增加体积感 */}
        <path
          className="wb-scene__fuji-shadow"
          d="M880 196 C 898 250 912 300 940 360 C 1060 640 1200 780 1290 900 L 1000 900 C 1010 700 950 480 880 196 Z"
        />
        {/* 雪顶：底边铺到山体左右坡，用两段柔和下坠收边，避免锯齿太密像一排尖刺 */}
        <path
          className="wb-scene__snow"
          d="M880 196 C 898 250 912 300 940 360 C 926 374 908 386 892 380 C 878 375 862 392 846 384 C 836 379 828 366 822 352 C 836 300 856 240 880 196 Z"
        />
        {/* 雪顶右侧的冷影，避免雪面变成一块死白 */}
        <path className="wb-scene__snow-shadow" d="M880 196 C 898 250 912 300 940 360 C 928 372 914 384 902 382 C 896 320 888 254 880 196 Z" />
        {/* 前景山脚：压暗底部，与页面底色衔接 */}
        <path
          className="wb-scene__foothill"
          d="M0 900 C 220 810 420 858 640 826 C 860 794 1080 856 1300 818 C 1420 800 1520 822 1600 804 L 1600 900 Z"
        />
      </svg>

      {/* 文案侧提亮层：左侧柔和过渡，右半段完全透明，山体与花瓣不受影响 */}
      <div className="wb-scene__veil" />

      {/* 地平线以下的夜雾：山脚完整保留轮廓，只把最底部渐隐到夜空色，
          页脚文字始终落在深底上 */}
      <div className="wb-scene__ground" />

      {/* 右侧樱花枝：背景枯枝先铺一层，前景主枝与花朵压在上面。
          枝条全部由分段 stroke 拼成，宽度逐段收细，模拟主干到末梢的锥度 */}
      <svg className="wb-scene__branch" viewBox="0 0 520 900" preserveAspectRatio="xMaxYMin meet" focusable="false">
        <g className="wb-scene__branch-far" fill="none">
          {FAR_BRANCHES.map((segment) => (
            <path key={segment.d} strokeWidth={segment.width} d={segment.d} />
          ))}
        </g>
        <g opacity="0.62">
          {FAR_BLOSSOMS.map((blossom) => (
            <BlossomMark key={`${blossom.x}-${blossom.y}-${blossom.kind}`} {...blossom} />
          ))}
        </g>
        <g fill="none">
          {MAIN_BRANCHES.map((segment) => (
            <path
              key={segment.d}
              className={segment.width >= 4 ? "wb-scene__branch-wood" : "wb-scene__branch-wood-soft"}
              strokeWidth={segment.width}
              d={segment.d}
            />
          ))}
        </g>
        {BLOSSOMS.map((blossom) => (
          <BlossomMark key={`${blossom.x}-${blossom.y}-${blossom.kind}`} {...blossom} />
        ))}
      </svg>

      <div className="wb-scene__petals">
        {PETALS.map((petal, index) => (
          <span
            className={`wb-scene__petal wb-scene__petal--${petal.path} wb-scene__petal--${petal.tone}`}
            // 花瓣是纯装饰，index 仅用于稳定 key
            // eslint-disable-next-line react/no-array-index-key
            key={index}
            style={petalStyle(petal)}
          >
            <span className="wb-scene__petal-inner" />
          </span>
        ))}
      </div>

      <div className="wb-scene__cranes">
        {CRANES.map((crane) => (
          <div className={`wb-crane ${crane.className}`} key={crane.className} style={craneStyle(crane)}>
            <div className="wb-crane__bob">
              <CraneSilhouette />
            </div>
          </div>
        ))}
      </div>

      <p className="wb-scene__caption">富士山下，樱花落时。</p>
    </div>
  );
}
