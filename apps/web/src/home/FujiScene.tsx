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

/** 前景樱花枝上的花簇：[x, y, r] */
const BLOSSOMS: Array<[number, number, number]> = [
  [418, 56, 12],
  [392, 70, 14],
  [372, 78, 11],
  [340, 72, 13],
  [306, 68, 10],
  [274, 76, 12],
  [266, 82, 9],
  [322, 118, 13],
  [292, 116, 11],
  [262, 122, 14],
  [238, 132, 10],
  [230, 138, 9],
  [306, 232, 12],
  [316, 262, 14],
  [324, 294, 11],
  [330, 322, 13],
  [288, 262, 10],
  [262, 274, 13],
  [232, 290, 11],
  [212, 302, 12],
  [322, 342, 12],
  [304, 358, 13],
  [286, 376, 11],
  [276, 386, 9],
];

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
      <svg className="wb-scene__mountains" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice" focusable="false">
        {/* 星点：静态小圆，只提气氛，不抢山体 */}
        {STARS.map(([cx, cy, r, opacity], index) => (
          // 星点仅用于装饰，index 作为稳定 key
          // eslint-disable-next-line react/no-array-index-key
          <circle className="wb-scene__star" key={index} cx={cx} cy={cy} r={r} opacity={opacity} />
        ))}
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

      {/* 右侧前景樱花枝：静态 SVG，花瓣从枝头区域出发 */}
      <svg className="wb-scene__branch" viewBox="0 0 520 900" preserveAspectRatio="xMaxYMin meet" focusable="false">
        <g fill="none" strokeLinecap="round">
          <path className="wb-scene__branch-wood" strokeWidth="10" d="M520 20 C 452 42 402 70 356 112 C 322 143 300 176 296 218" />
          <path className="wb-scene__branch-wood-soft" strokeWidth="4.5" d="M392 78 C 352 64 312 64 268 76" />
          <path className="wb-scene__branch-wood-soft" strokeWidth="4.5" d="M344 122 C 308 114 274 118 232 134" />
          <path className="wb-scene__branch-wood-soft" strokeWidth="4.5" d="M300 210 C 320 248 334 286 330 330" />
          <path className="wb-scene__branch-wood-soft" strokeWidth="4" d="M310 250 C 282 274 252 292 214 300" />
          <path className="wb-scene__branch-wood-soft" strokeWidth="3.6" d="M332 328 C 312 352 296 368 278 386" />
        </g>
        {BLOSSOMS.map(([cx, cy, r], index) => (
          // 花簇仅用于装饰，index 作为稳定 key
          // eslint-disable-next-line react/no-array-index-key
          <g key={index}>
            <circle className="wb-scene__bloom" cx={cx} cy={cy} r={r} />
            <circle className="wb-scene__bloom-core" cx={cx - r * 0.2} cy={cy - r * 0.2} r={r * 0.34} />
          </g>
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
