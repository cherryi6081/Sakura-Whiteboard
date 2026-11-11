import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Crane } from "./Crane";
import { WebglScene, decideRenderMode } from "./webgl/WebglScene";
import type { Period } from "./usePeriod";
import {
  LEFT_FAR_PAINT,
  LEFT_FAR_TREE,
  LEFT_HIGH_PAINT,
  LEFT_HIGH_TREE,
  LEFT_LOW_PAINT,
  LEFT_LOW_TREE,
  LEFT_PAINT,
  LEFT_TREE,
  RIGHT_FAR_PAINT,
  RIGHT_FAR_TREE,
  RIGHT_HIGH_PAINT,
  RIGHT_HIGH_TREE,
  RIGHT_LOW_PAINT,
  RIGHT_LOW_TREE,
  RIGHT_PAINT,
  RIGHT_TREE,
  toPathData,
  type Blossom,
  type BranchSegment,
} from "./fujiBranches";
import {
  CRANE_VISUAL_TO_STAGE,
  FLOATING_PETALS,
  fallingRatioBySize,
  floatingRatioBySize,
  petalEdgePx,
  type FloatingPetal,
} from "./floatingPetals";
import {
  FLASH_PEAK_OPACITY,
  FLASH_SPLASH_SECONDS,
  INNER_PEAK_OPACITY,
  INNER_SPLASH_DELAY,
  INNER_SPLASH_SECONDS,
  MAX_CONCURRENT_DESKTOP,
  MAX_CONCURRENT_MOBILE,
  MIN_RIPPLE_X_GAP_PX,
  MIN_RIPPLE_X_GAP_PX_MOBILE,
  OUTER_PEAK_OPACITY,
  OUTER_SPLASH_SECONDS,
  petalFade,
  planRipples,
  splashFrames,
  waterTime,
  WIDE_PEAK_OPACITY,
  WIDE_SPLASH_DELAY,
  WIDE_SPLASH_SECONDS,
  WIDE_START_SCALE,
  WIDER_PEAK_OPACITY,
  WIDER_SPLASH_DELAY,
  WIDER_SPLASH_SECONDS,
  WIDER_START_SCALE,
  type RippleInput,
} from "./petalRipples";

/**
 * 首页右下角题词。呈现已从首页移除（节点与 `.wb-scene__caption` 样式一并删除），
 * 文案按“能保留就保留在代码层”的要求留作常量，需要时再挂回场景。
 */
export const SCENE_CAPTION = "富士山下，樱花落时。";

/**
 * 首页整页场景：富士山全景 + 右侧樱花枝 + 曲线飘散花瓣。
 *
 * 实现选择：花瓣用 **纯 CSS 多关键帧 transform/opacity**，不用 canvas。
 * 理由：元素数量有限（桌面 26 片花瓣），CSS 动画由合成器在 GPU 上推进，
 * 不占主线程、也不需要 rAF 常驻循环；canvas 在这个量级反而要自管 DPR、清理与
 * prefers-reduced-motion，收益不大。代价是路径在 CSS 里写死，靠 `path` 变体
 * + 每个元素的时长/延迟/旋转系数制造差异，避免 26 段重复关键帧。
 *
 * 轨迹：A 向左下弧线、B 向右下弧线、C 先右后左的 S 弧。每段用不同
 * `animation-timing-function`（起步 ease-in → 中段 ease-in-out → 末段 ease-in），
 * 模拟风推 + 重力加速；旋转角度按 `--p-spin` 逐片放大，避免整齐划一。
 */

type PetalPath = "a" | "b" | "c" | "d";
type PetalTone = "light" | "mid" | "deep";

export type Petal = {
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
  /** 贴近水面前行的慢速花瓣：周期拉长，制造风流般的滞空感 */
  slow?: boolean;
};

export const PETALS: Petal[] = [
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
  { left: 95, top: 18, size: 13, dur: 25, delay: -18, spin: 0.8, opacity: 0.45, tone: "light", path: "c" },
  { left: 68, top: 31, size: 11, dur: 28, delay: -23, spin: 1.2, opacity: 0.34, tone: "light", path: "a" },
  { left: 76, top: 34, size: 16, dur: 19, delay: -13, spin: 1.05, opacity: 0.64, tone: "mid", path: "c", slow: true },
  { left: 84, top: 37, size: 13, dur: 24, delay: -5, spin: 0.9, opacity: 0.52, tone: "light", path: "a", slow: true },
  { left: 91, top: 32, size: 18, dur: 17, delay: -15, spin: 1.15, opacity: 0.72, tone: "mid", path: "a" },
  { left: 96, top: 40, size: 15, dur: 22, delay: -7, spin: 1, opacity: 0.6, tone: "deep", path: "b", slow: true },
];

/**
 * 左侧飘落花瓣：与右侧同属一套花瓣与动画，但起点集中在左半屏、数量更少（10 片 vs 26 片），
 * 时长与延迟刻意不与右侧重合（右侧多为整数秒的整数倍负延迟），摆动方向统一向右下，
 * 避免从左侧落下时立刻被甩出画面。路径只用 b（右下弧）与 d（先右后回摆的缓 S 弧）。
 */
export const LEFT_PETALS: Petal[] = [
  { left: 3, top: -8, size: 14, dur: 27, delay: -5.5, spin: 0.75, opacity: 0.45, tone: "light", path: "b" },
  { left: 9, top: 12, size: 19, dur: 21, delay: -13.5, spin: 1.05, opacity: 0.76, tone: "mid", path: "d" },
  { left: 15, top: -12, size: 12, dur: 29, delay: -20.5, spin: 0.8, opacity: 0.4, tone: "light", path: "d" },
  { left: 21, top: 6, size: 16, dur: 17, delay: -3.5, spin: 1.2, opacity: 0.68, tone: "deep", path: "b" },
  { left: 27, top: -4, size: 22, dur: 15, delay: -16.5, spin: 0.9, opacity: 0.84, tone: "mid", path: "d" },
  { left: 33, top: 18, size: 13, dur: 25, delay: -8.5, spin: 1.25, opacity: 0.52, tone: "light", path: "b" },
  { left: 38, top: 2, size: 17, dur: 19, delay: -23.5, spin: 1, opacity: 0.7, tone: "deep", path: "d" },
  { left: 12, top: 28, size: 12, dur: 24, delay: -11.5, spin: 0.95, opacity: 0.44, tone: "light", path: "b" },
  { left: 24, top: 33, size: 15, dur: 18, delay: -18.5, spin: 1.1, opacity: 0.6, tone: "mid", path: "b" },
  { left: 41, top: 24, size: 10, dur: 28, delay: -7.5, spin: 1.3, opacity: 0.36, tone: "light", path: "d" },
];


/** 水线：山脚与湖面的分界，倒影以它为镜像轴 */
const WATERLINE = 566;

/**
 * 山体形状（按参考图重画）：左右坡接近直线、山体宽扁、峰顶小圆角，
 * 雪顶覆盖到山体上部约三分之一，雪线下沿是一排尖角状的融雪边。
 * 倒影直接复用这一组路径做垂直镜像，所以倒影轮廓与山体、雪顶严格对应。
 */
/**
 * 雪线：一排宽窄不等的融雪齿（从左到右），窄深齿（880 / 922）像下滑的雪舌，
 * 宽浅齿（838 / 886 / 748）像融塌的雪檐下沿。
 *
 * 这里只定义“雪线下沿”，不定义雪顶形状：雪顶由山体轮廓 body 与这条雪线求交派生
 * （见 SNOW_CLIP + MountainShapes）。雪线向左右各延伸出山体之外再向上闭合，
 * 所以交线的左右端点必然落在左坡/右坡轮廓线上，左右坡换坡度时也不会再露岩缝。
 */
const SNOW_TEETH: Array<[number, number]> = [
  [704, 322],
  [726, 318],
  [748, 344],
  [766, 308],
  [780, 336],
  [794, 306],
  [806, 340],
  [828, 312],
  [838, 352],
  [862, 306],
  [880, 362],
  [886, 316],
  [910, 305],
  [922, 342],
  [930, 298],
];

/** 雪线以上区域：融雪齿两端各横伸到山体之外，再向上闭合成一个裁切区 */
const SNOW_CLIP = [
  `M-240 ${SNOW_TEETH[0][1]}`,
  ...SNOW_TEETH.map(([x, y]) => `L${x} ${y}`),
  `L1840 ${SNOW_TEETH[SNOW_TEETH.length - 1][1]}`,
  "L1840 -240 L-240 -240 Z",
].join(" ");

const MOUNTAIN_PATHS = {
  // 峰顶不是尖点：从左坡 (744,244) 收到 (792,208)，向右平出到 (816,212) 再下坡，
  // 形成参考图里那种极短的山顶平台；左右坡各留一个换坡度的转折（520/646 与 1010）。
  // 雪顶直接复用这一条轮廓做裁切，不再另写一套左右端点，换坡点改了也不会错位
  body: "M170 566 L356 468 L520 380 L646 308 L744 244 L792 208 L816 212 L872 252 L1010 338 L1238 468 L1400 566 Z",
  // 背光面：外沿贴右坡，内沿是分水脊。脊线不再是一根直线，从峰顶经过
  // (830,270)(868,330)(930,400)(1000,462)(1080,512) 几个换坡点落到右山脚，
  // 让阴影边界带自然的折角，和雪顶的受光/背光分界对得上
  shadow:
    "M792 208 L816 212 L872 252 L1010 338 L1238 468 L1400 566 L1180 566 " +
    "L1150 545 L1080 512 L1000 462 L930 400 L868 330 L830 270 Z",
  band: "M170 566 L300 534 L520 506 L760 496 L1040 500 L1250 516 L1400 566 Z",
  // 背光雪面：外沿贴右侧雪脊（与 body 共用峰顶与右坡点），内沿顺融雪齿回收到雪脊内侧
  snowShadow:
    "M792 208 L816 212 L860 244 L902 274 L930 298 L922 342 L910 305 L886 316 L880 362 " +
    "L862 306 L838 352 L828 312 L820 286 L810 250 Z",
  // 雪面折影：受光面上的一块窄三角，交代雪脊两侧的坡向变化（不是描边）
  snowFolds: "M760 272 L786 300 L770 310 L744 282 Z",
  // 雪檐下的投影：贴着上脊的一道窄楔，整个落在雪面内侧，靠近峰顶处最宽
  snowCrest: "M764 256 L792 208 L816 212 L812 222 L790 216 L768 264 Z",
};

function MountainShapes() {
  return (
    <g>
      <path className="wb-scene__fuji" d={MOUNTAIN_PATHS.body} />
      <path className="wb-scene__fuji-shadow" d={MOUNTAIN_PATHS.shadow} />
      <path className="wb-scene__foothill" d={MOUNTAIN_PATHS.band} />
      {/* 雪顶 = 山体轮廓 ∩ 雪线以上区域：上沿就是 body 本身，左右两端由轮廓线决定，
          不再手写雪顶端点，也就不会再在左坡露出岩缝 */}
      <g transform="translate(0 9)">
        {/* 雪与岩的接触影：整块雪本体（含轮廓）先整体下错 9 单位，被雪盖住后
            只在融雪齿下沿留一条窄影，雪就不是“贴”在岩面上，而是压出厚度 */}
        <path className="wb-scene__snow-contact" d={MOUNTAIN_PATHS.body} clipPath="url(#wb-snow-clip)" />
      </g>
      <path className="wb-scene__snow" d={MOUNTAIN_PATHS.body} clipPath="url(#wb-snow-clip)" />
      <path className="wb-scene__snow-shadow" d={MOUNTAIN_PATHS.snowShadow} />
      <path className="wb-scene__snow-fold" d={MOUNTAIN_PATHS.snowFolds} />
      <path className="wb-scene__snow-crest" d={MOUNTAIN_PATHS.snowCrest} />
    </g>
  );
}

/**
 * 倒影：绕水线做纯镜像，y' = 2·WATERLINE − y（等价于 translate(0, 1132) scale(1, -1)）。
 *
 * 上一版是三段、每段 0.72 纵向压缩 + 0 / +4 / −5 横向错位。纯镜像后这两项都失去意义：
 * 压缩比统一成 1（山体水线以上高 358，倒影尖端落到 566 + 358 = 924，超出 900 的画布，
 * 被画面底干净裁掉 24 单位 —— 这是纯镜像的必然结果，不缩放、不抬水线），横向错位归零，
 * 峰顶倒影正对峰顶。
 *
 * 三段合并成一段：纯镜像后段与段之间不再有几何差，只剩不透明度台阶（0.9 / 0.85 / 0.76），
 * 留着必然在 662 / 744 两条边界上留下可见接缝。合并后由下面 #wb-ref-fade 渐变
 * （0 / 55 / 78 / 100%）做自下而上的连续衰减，与 WebGL 着色器里的 fade 曲线同量级。
 */
const REFLECT_MIRROR = `translate(0 ${WATERLINE * 2}) scale(1 -1)`;
const REFLECT_OPACITY = 0.9;

/**
 * 静态水纹：[x, y, 宽度, 不透明度]，12 条，与 WebGL 的 LAKE_LINES 逐项一致。
 *
 * 高度 2.4、圆角半径 1.2（端头就是半圆），颜色 --lake-ripple，单条透明度 0.22–0.5。
 * 分布从水线附近一路铺到近岸；叠放次序是「水纹 → 倒影」，倒影不透明度 0.9 会把
 * 落在山体范围内的水纹压住 9 成，只在轮廓之外的水面露出，所以条数从 5 恢复到 12
 * 也不会横穿脊线或融雪齿。
 */
const RIPPLES: Array<[number, number, number, number]> = [
  [40, 594, 110, 0.5],
  [1444, 604, 112, 0.42],
  [236, 620, 86, 0.34],
  [1268, 636, 94, 0.3],
  [92, 668, 132, 0.28],
  [1382, 694, 118, 0.26],
  [520, 712, 96, 0.22],
  [980, 732, 108, 0.24],
  [1150, 790, 102, 0.3],
  [292, 856, 148, 0.26],
  [686, 874, 126, 0.22],
  [1116, 842, 138, 0.24],
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

/** 前景枝段：粗段用深木色、末梢用浅木色；顺序已由 paintOrder 排成"子先父后" */
function BranchPaths({ segments }: { segments: ReadonlyArray<BranchSegment> }) {
  return (
    <g fill="none">
      {segments.map((segment) => (
        <path
          key={segment.id}
          className={segment.width >= 4 ? "wb-scene__branch-wood" : "wb-scene__branch-wood-soft"}
          strokeWidth={segment.width}
          d={toPathData(segment.points)}
        />
      ))}
    </g>
  );
}

/**
 * 一组独立的枝干丛：枝段 + 花，整体用两个透明度分档。
 * 高位远景组复用 `.wb-scene__branch-far` 的浅木色与 0.48 透明度；
 * 低位中景组沿用前景木色，整组压到 0.88，花略亮于枝。
 */
function BranchCluster({
  paint,
  blossoms,
  prefix,
  far = false,
  branchOpacity = 1,
  blossomOpacity = 1,
}: {
  paint: ReadonlyArray<BranchSegment>;
  blossoms: ReadonlyArray<Blossom>;
  prefix: string;
  far?: boolean;
  branchOpacity?: number;
  blossomOpacity?: number;
}) {
  return (
    <>
      {far ? (
        <g className="wb-scene__branch-far" fill="none">
          {paint.map((segment) => (
            <path key={segment.id} strokeWidth={segment.width} d={toPathData(segment.points)} />
          ))}
        </g>
      ) : (
        <g fill="none" opacity={branchOpacity}>
          {paint.map((segment) => (
            <path
              key={segment.id}
              className={segment.width >= 4 ? "wb-scene__branch-wood" : "wb-scene__branch-wood-soft"}
              strokeWidth={segment.width}
              d={toPathData(segment.points)}
            />
          ))}
        </g>
      )}
      <g opacity={blossomOpacity}>
        {blossoms.map((blossom, index) => (
          <BlossomMark key={`${prefix}-${blossom.segmentId}-${blossom.t}-${index}`} {...blossom} />
        ))}
      </g>
    </>
  );
}

/**
 * 每条轨迹的横向摆幅：`--p-sway` 表示整段轨迹里**最大横向位移**（带方向的正负长度），
 * 关键帧里各时刻的位移都是它的固定比例。left/right 是该轨迹用到的最大向左/向右比例，
 * 用来按每片花瓣到画面左右边缘的余量反算 sway，保证整段轨迹都在 3%–97% 之间。
 */
const PETAL_SWAY: Record<PetalPath, { dir: 1 | -1; left: number; right: number }> = {
  a: { dir: -1, left: 1, right: 0 },
  b: { dir: 1, left: 0, right: 1 },
  c: { dir: 1, left: 0.71, right: 1 },
  d: { dir: 1, left: 0, right: 1 },
};

/**
 * 每片花瓣实际用到的横向摆幅与纵向落距。
 * 涟漪落点要和花瓣轨迹严格对齐，所以这两项抽成公共函数，CSS 变量与涟漪计算共用同一份数值。
 */
export function petalGeometry(petal: Petal) {
  const { dir, left, right } = PETAL_SWAY[petal.path];
  // 左右各留 3% 余量：花瓣中心始终在 3%–97% 之间
  const roomLeft = Math.max(0, petal.left - 3);
  const roomRight = Math.max(0, 97 - petal.left);
  const limit = Math.min(left > 0 ? roomLeft / left : Infinity, right > 0 ? roomRight / right : Infinity);
  const base = petal.path === "a" ? 28 : petal.path === "b" ? 24 : petal.path === "c" ? 14 : 10;
  const sway = dir * Math.min(base, limit);
  // 终点统一落在 92% 高度：整段轨迹都在视口内，透明度先归零再结束，不会被底部裁断
  const fall = Math.max(20, 92 - petal.top);
  // 与写进 CSS 变量的精度一致，涟漪按同一组数字复算落点
  return { sway: +sway.toFixed(2), fall: +fall.toFixed(2) };
}

function petalStyle(petal: Petal): CSSProperties {
  const { sway, fall } = petalGeometry(petal);
  // 长边 = 档位比 × 鹤视觉高度；--crane-h 是舞台高度，乘 1.3898 换成含倾角的视觉高度。
  // max() 里的 --petal-floor 由 CSS 按桌面/移动端给 4px / 3px，和涟漪用的是同一档位比
  const ratio = +(fallingRatioBySize(petal.size) * CRANE_VISUAL_TO_STAGE).toFixed(4);
  return {
    "--p-top": `${petal.top}%`,
    "--p-left": `${petal.left}%`,
    "--p-size": `max(var(--petal-floor), calc(var(--crane-h) * ${ratio}))`,
    "--p-dur": `${petal.slow ? +(petal.dur * 1.75).toFixed(1) : petal.dur}s`,
    "--p-delay": `${petal.delay}s`,
    "--p-spin": petal.spin,
    "--p-opacity": petal.opacity,
    "--p-sway": `${sway}vw`,
    "--p-fall": `${fall}vh`,
  } as CSSProperties;
}

/** 湖面漂浮花瓣的样式变量：位置 / 深浅 / 尺寸 / 倾角 / 漂移幅度 / 周期，全部交给 CSS */
function floatStyle(petal: FloatingPetal): CSSProperties {
  const aspect = 0.34 + 0.5 * petal.depth;
  const ratio = +(floatingRatioBySize(petal.size) * CRANE_VISUAL_TO_STAGE).toFixed(4);
  return {
    "--f-x": petal.x,
    "--f-depth": petal.depth,
    "--f-w": `max(var(--petal-floor), calc(var(--crane-h) * ${ratio}))`,
    "--f-h": `calc(var(--f-w) * ${+aspect.toFixed(2)})`,
    "--f-rot": `${petal.rot}deg`,
    "--f-tilt": `${petal.tilt}deg`,
    "--f-dx": `${petal.dx}px`,
    "--f-dy": `${petal.dy}px`,
    "--f-dur": `${petal.dur}s`,
    "--f-delay": `${petal.delay}s`,
    "--f-pulse": `${petal.pulse}s`,
    "--f-pulse-delay": `${petal.pulseDelay}s`,
  } as CSSProperties;
}

/** 桌面端全量花瓣：右侧 26 片在前、左侧 10 片在后，下标就是涟漪占位元素的顺序 */
const ALL_PETALS: ReadonlyArray<Petal> = [...PETALS, ...LEFT_PETALS];

/** 移动端仍可见的花瓣数量，与 pages.css 的 nth-child 收口一一对应 */
const MOBILE_RIGHT_VISIBLE = 16;
const MOBILE_LEFT_VISIBLE = 8;

/** 并发统计的时间窗口（秒）：覆盖 14–29s 的各种周期 */
const RIPPLE_HORIZON = 900;

export function FujiScene({ period }: { period: Period }) {
  const rippleLayer = useRef<HTMLDivElement>(null);
  /**
   * 桌面端 WebGL 接管天空以外的绘画层后，SVG 里被替掉的部分用 CSS 隐藏，
   * 只保留樱花枝、鹤、小舟、雁群这些前景覆盖层。渲染模式在首次渲染前同步判定：
   * `data-render` 第一帧就是最终值，不会先画 SVG 再跳成 WebGL。
   * 判定不通过（窄屏 / reduce / 省流 / 无 WebGL2）时首帧直接出 SVG。
   */
  const [renderMode, setRenderMode] = useState<"svg" | "webgl">(decideRenderMode);
  /** WebGL 首帧画完的标志：用于把静态湖色衬底交接给 WebGL 水面 */
  const [webglReady, setWebglReady] = useState(false);
  useEffect(() => {
    if (renderMode !== "webgl") setWebglReady(false);
  }, [renderMode]);

  /**
   * 涟漪的排布。为什么放在 effect 里而不是渲染时算：
   * 入水时刻取决于水线，水线随视口宽高比变化（16:9 ≈ 66.6%、超宽屏 ≈ 62.9%、4:3 ≈ 72.2%、
   * 手机 ≈ 90.4%），只能在使用 `window.innerWidth / innerHeight` 时计算。
   * 这里只在挂载、窗口尺寸变化和 reduce 偏好切换时重排，不做任何逐帧监听；
   * 动画本身交给合成器（只动 transform / opacity），与花瓣同周期同延迟，长期不漂移。
   */
  useEffect(() => {
    const layer = rippleLayer.current;
    if (!layer) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const slots = Array.from(layer.children) as HTMLElement[];
    const petalNodes = [
      ...Array.from(document.querySelectorAll<HTMLElement>(".wb-scene__petals:not(.wb-scene__petals--left) .wb-scene__petal")),
      ...Array.from(document.querySelectorAll<HTMLElement>(".wb-scene__petals--left .wb-scene__petal")),
    ];
    let animations: Animation[] = [];
    let frame = 0;

    const clear = () => {
      for (const animation of animations) animation.cancel();
      animations = [];
      for (const slot of slots) slot.style.left = "0%";
    };

    const build = () => {
      clear();
      if (reduce.matches) return;

      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // 与 .wb-scene__water 同一套公式：内容高度 = min(16:9 宽, 视口高)
      const contentH = Math.min(0.5625 * vw, vh);
      const waterlinePct = ((vh - 0.371111 * contentH) / vh) * 100;
      const mobile = vw <= 767;

      const inputs: RippleInput[] = [];
      for (let key = 0; key < ALL_PETALS.length; key++) {
        const petal = ALL_PETALS[key];
        const localIndex = key < PETALS.length ? key : key - PETALS.length;
        const visible = mobile
          ? localIndex < (key < PETALS.length ? MOBILE_RIGHT_VISIBLE : MOBILE_LEFT_VISIBLE)
          : true;
        if (!visible) continue;
        const geometry = petalGeometry(petal);
        const input: RippleInput = {
          key,
          left: petal.left,
          top: petal.top,
          dur: petal.dur,
          delay: petal.delay,
          size: petalEdgePx(fallingRatioBySize(petal.size), vw, vh),
          path: petal.path,
          sway: geometry.sway,
          fall: geometry.fall,
        };
        inputs.push(input);

        // 花瓣的透明度不能交给固定百分比的关键帧：水线随宽高比在 63%–90% 之间变化，
        // 手机上的花瓣要到周期 98% 才穿水线，而 CSS 关键帧 92% 就开始淡出，
        // 等于花瓣在水线之上就消失了，涟漪看起来是凭空冒出来的圆环。
        // 这里按视口把「淡出窗口」对齐到真正的入水时刻，花瓣一定是看得见地落到水面再消失。
        const node = petalNodes[key];
        if (node) {
          const fade = petalFade(waterTime(input, waterlinePct, vh));
          // 入水点在周期极靠前时，fade.start 会早于固定的 0.05 淡入点；
          // 关键帧 offset 必须单调不减，所以这里取两者的较小值，且不重复插同一个点
          const fadeIn = Math.min(0.05, fade.start);
          const frames: Keyframe[] = [{ opacity: 0, offset: 0 }];
          if (fadeIn < fade.start) frames.push({ opacity: petal.opacity, offset: fadeIn });
          frames.push({ opacity: petal.opacity, offset: fade.start }, { opacity: 0, offset: fade.end });
          if (fade.end < 0.999) frames.push({ opacity: 0, offset: 1 });
          animations.push(
            node.animate(frames, {
              duration: petal.dur * 1000,
              delay: petal.delay * 1000,
              iterations: Infinity,
            }),
          );
        }
      }

      const plans = planRipples(inputs, {
        waterlinePct,
        vh,
        // 触发区域是「水线以下的整片水面」：超宽屏两侧的 CSS 湖带也是水，
        // 涟漪层本身已经铺满全宽，所以左右边缘同样要能落涟漪
        minX: 0,
        maxX: 100,
        // 间距用 px 定，换算成视口百分比；移动端屏幕窄，间距收得更小才能保证任意 4s 内都有涟漪
        xGap: ((mobile ? MIN_RIPPLE_X_GAP_PX_MOBILE : MIN_RIPPLE_X_GAP_PX) / vw) * 100,
        cap: mobile ? MAX_CONCURRENT_MOBILE : MAX_CONCURRENT_DESKTOP,
        horizon: RIPPLE_HORIZON,
      });

      for (const plan of plans) {
        const slot = slots[plan.key];
        if (!slot) continue;
        slot.style.left = `${plan.x.toFixed(2)}%`;
        const rings = Array.from(slot.children) as HTMLElement[];
        const timing = { duration: plan.cycle * 1000, delay: plan.delay * 1000, iterations: Infinity };
        // 五圈叠加：外圈 1.7s、内圈 1.45s（晚 0.32s）、两圈余波 2.4s / 3.2s（更宽更淡）、
        // 入水瞬间 0.5s 的亮面短闪。都跟花瓣同周期同延迟，只在入水时刻张开一次，
        // 不重影也不同拍；余波从更小的相对尺度起振，张开后仍落在主圈之外
        animations.push(
          rings[0].animate(splashFrames(plan.at, plan.cycle, OUTER_SPLASH_SECONDS, OUTER_PEAK_OPACITY), timing),
          rings[1].animate(
            splashFrames(
              plan.at + INNER_SPLASH_DELAY / plan.cycle,
              plan.cycle,
              INNER_SPLASH_SECONDS,
              INNER_PEAK_OPACITY,
            ),
            timing,
          ),
          rings[2].animate(
            splashFrames(
              plan.at + WIDE_SPLASH_DELAY / plan.cycle,
              plan.cycle,
              WIDE_SPLASH_SECONDS,
              WIDE_PEAK_OPACITY,
              WIDE_START_SCALE,
            ),
            timing,
          ),
          rings[3].animate(
            splashFrames(
              plan.at + WIDER_SPLASH_DELAY / plan.cycle,
              plan.cycle,
              WIDER_SPLASH_SECONDS,
              WIDER_PEAK_OPACITY,
              WIDER_START_SCALE,
            ),
            timing,
          ),
          rings[4].animate(
            splashFrames(plan.at, plan.cycle, FLASH_SPLASH_SECONDS, FLASH_PEAK_OPACITY, 0.5),
            timing,
          ),
        );
      }
    };

    // 尺寸拖动时合并到下一帧，避免连续 resize 反复重建动画
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        build();
      });
    };

    build();
    window.addEventListener("resize", schedule);
    reduce.addEventListener("change", build);
    return () => {
      window.removeEventListener("resize", schedule);
      reduce.removeEventListener("change", build);
      if (frame) cancelAnimationFrame(frame);
      clear();
    };
  }, []);

  return (
    <div
      className="wb-home__scene"
      aria-hidden="true"
      data-render={renderMode}
      data-webgl-ready={webglReady ? "true" : "false"}
    >
      <WebglScene
        period={period}
        mode={renderMode}
        onModeChange={setRenderMode}
        onFirstFrame={() => setWebglReady(true)}
      />
      {/* 水天延展层：天空渐变已由 .wb-home__scene 的 CSS 背景铺满整个视口，
          但湖面渐变画在下面的 SVG 里，只能覆盖 16:9 内容宽。视口比 16:9 更宽时
          （21:9、带鱼屏）内容两侧会露出"天空一直延伸到画面底部"的色带。
          这里用一层与视口同宽、底边贴底的 CSS 湖带补上水线以下的部分：
          高度、四档湖色与倒影淡出严格控制成与 SVG 内一致，中间区域被 SVG 湖面完全盖住，
          只有超宽屏的左右两翼能看到它，于是两翼是延展的水天而不是空白 */}
      <div className="wb-scene__water" />

      {/* 山 + 湖面倒映：viewBox 里同时排进山峰、两侧山脚、水线与湖底，
          meet 保证整组完整可见；天空由底层 CSS 渐变铺满，不留白边 */}
      <svg className="wb-scene__mountains" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMax meet" focusable="false">
        <defs>
          {/* 雪顶裁切区：只保留雪线以上部分。山体本体与倒影共用这一条，两端自然落在轮廓上 */}
          <clipPath id="wb-snow-clip">
            <path d={SNOW_CLIP} />
          </clipPath>
          <linearGradient id="wb-lake-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" className="wb-scene__lake-stop-0" />
            <stop offset="28%" className="wb-scene__lake-stop-1" />
            <stop offset="66%" className="wb-scene__lake-stop-2" />
            <stop offset="100%" className="wb-scene__lake-stop-3" />
          </linearGradient>
          <linearGradient id="wb-ref-fade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" className="wb-scene__ref-stop-0" />
            <stop offset="55%" className="wb-scene__ref-stop-1" />
            <stop offset="78%" className="wb-scene__ref-stop-2" />
            <stop offset="100%" className="wb-scene__ref-stop-3" />
          </linearGradient>
          {/* 霞带：径向渐隐。以椭圆自身为 100%，横竖两个方向同步柔化，
              没有「中间一整条实白、到端头才消失」的硬芯，读起来只是一团薄雾 */}
          <radialGradient id="wb-cloud-soft">
            <stop offset="0%" className="wb-scene__cloud-stop-0" />
            <stop offset="34%" className="wb-scene__cloud-stop-1" />
            <stop offset="70%" className="wb-scene__cloud-stop-2" />
            <stop offset="100%" className="wb-scene__cloud-stop-3" />
          </radialGradient>
          {/* 渔火光晕：中心近白偏黄、向外两档收淡到全透明 */}
          <radialGradient id="wb-boat-glow">
            <stop offset="0%" className="wb-scene__boat-glow-0" />
            <stop offset="42%" className="wb-scene__boat-glow-1" />
            <stop offset="100%" className="wb-scene__boat-glow-2" />
          </radialGradient>
        </defs>

        {/* 霞带（峰侧斜霞）：左右两条微微倾斜、互不等高的云带自画面外伸入，
            中央整块让开品牌区（樱花白板 / SHIRO / REAL-TIME… 约占 x 650–950、y 45–145）。
            上沿约在 y≈152（倾斜端头已渐隐到几乎无色），不与品牌区重叠；肩部再补一道极淡短纱，
            它压在雪顶下方、且被后画的山体压住中段，读作从山后飘过的薄云。
            全部用同一个径向渐隐渐变，横竖两个方向一起化进天空，没有硬边 */}
        <ellipse className="wb-scene__cloud" cx="270" cy="178" rx="330" ry="18" transform="rotate(-2.5 270 178)" fill="url(#wb-cloud-soft)" opacity="0.62" />
        <ellipse className="wb-scene__cloud" cx="300" cy="204" rx="235" ry="11" transform="rotate(-2 300 204)" fill="url(#wb-cloud-soft)" opacity="0.36" />
        <ellipse className="wb-scene__cloud" cx="1310" cy="197" rx="355" ry="20" transform="rotate(2.2 1310 197)" fill="url(#wb-cloud-soft)" opacity="0.55" />
        <ellipse className="wb-scene__cloud" cx="800" cy="248" rx="230" ry="11" transform="rotate(-1.2 800 248)" fill="url(#wb-cloud-soft)" opacity="0.28" />

        {/* 雁群：极简 V 形笔触斜向上飞，只走右侧与左上空域，避开中央品牌区 */}
        <g className="wb-scene__geese">
          <path d="M1150 196 q10 -9 17 0 q7 -9 17 0" />
          <path d="M1198 216 q8 -7 14 0 q6 -7 14 0" />
          <path d="M1112 222 q7 -6 12 0 q5 -6 12 0" />
          <path d="M1230 190 q6 -5 10 0 q4 -5 10 0" />
          <path d="M300 246 q7 -6 12 0 q5 -6 12 0" />
          <path d="M352 262 q6 -5 10 0 q4 -5 10 0" />
        </g>

        {/* 湖面：从水线一直铺到画面底边 */}
        <rect className="wb-scene__lake" x="0" y={WATERLINE} width="1600" height={900 - WATERLINE} fill="url(#wb-lake-grad)" />

        {/* 静态水面反光：先画在倒影下面，只在倒影轮廓之外露出，
            所以不会有一条亮线横穿脊线或融雪齿 */}
        {RIPPLES.map(([x, y, width, opacity]) => (
          <rect
            className="wb-scene__lake-line"
            key={`${x}-${y}`}
            x={x}
            y={y}
            width={width}
            height="2.4"
            rx="1.2"
            opacity={opacity}
          />
        ))}

        {/* 倒影：整座山连同雪顶绕水线纯镜像（y' = 2·WATERLINE − y，dx = 0），单段不透明度 0.9。
            山体水线以上高 358，镜像尖端落到 y = 924，超出 900 的 viewBox 后被 svg 视口干净裁掉；
            WebGL 侧同一套几何同样落到舞台底之外，被画布底边裁掉，两边收口一致。
            自下而上的衰减交给下面的 #wb-ref-fade，单段没有段边界接缝 */}
        <g className="wb-scene__reflection" opacity={REFLECT_OPACITY} transform={REFLECT_MIRROR}>
          <MountainShapes />
        </g>

        {/* 水面渐隐层：前 55% 完全不动倒影，78% 之后才明显压向湖色，
            只把最靠近画面底部的一段化开，水线附近保持镜面清晰 */}
        <rect className="wb-scene__lake-fade" x="0" y={WATERLINE} width="1600" height={900 - WATERLINE} fill="url(#wb-ref-fade)" />

        <rect className="wb-scene__lake-horizon" x="0" y={WATERLINE - 1} width="1600" height="2.4" />

        {/* 湖面小舟与渔火：水线以下唯一的一点暖黄，给整片冷蓝一个温度锚点。
            C 版造型：穹顶苫布篷 + 篷檐右肩挂灯 + 上翘船首 + 船尾橹与绳结，
            灯是整条船唯一的暖色（也是全图唯一的渐变）。
            位置偏画面右侧的空白水域（x≈1272），与左侧的页脚文字、居中的 01/02/03 互不打扰。
            新画把局部 y=0 定义为吃水线（旧版 y=0 在船身上沿、水线约在 y≈8），
            所以锚点从 706 下移到 722，船在画面里的位置与旧版一致。 */}
        <g className="wb-scene__boat" transform="translate(1272 722) scale(2)">
          {/* 五层分工，避免多条曲线在同一个 transform 里互相抵消：
              drift 只横向漂移（41.3s）；heave + swell 两级不同周期的升沉（17.9s / 11.7s）；
              tilt 只做俯仰与极轻横摇（17.9s，相位比升沉提前 90°，船头先起）；
              reflection 只跟横漂、用明暗回应升沉。 */}
          <g className="wb-scene__boat-drift">
            <g className="wb-scene__boat-heave">
              <g className="wb-scene__boat-swell">
                {/* 船底投影：贴着水面的窄椭圆，让船"压"在水上而不是浮着。
                    不进 tilt 层：影子落在水面上，不跟着船体俯仰转 */}
                <ellipse className="wb-scene__boat-shadow" cx="0" cy="0.95" rx="19" ry="1.3" />
                <g className="wb-scene__boat-tilt">
                  {/* 橹与橹杭：先画，压在船身之下；局部 x 正向 = 船首 */}
                  <path className="wb-scene__boat-oar" d="M-17.6 -2.9 L-24.5 0.3" />
                  <path className="wb-scene__boat-oar-pivot" d="M-17.2 -0.8 L-17.2 -3.6" />
                  {/* 船身：舷弧从船尾 (−19.2,−4.2) 压平到中段 −2.8，首柱在 (19.3,−7.1) 收尖 */}
                  <path className="wb-scene__boat-hull" d="M-19.2 -4.2 C-17.2 -3.15 -13.6 -2.82 -9.4 -2.78 C-3 -2.72 3.6 -2.82 8.6 -3.05 C12.4 -3.2 15 -3.85 16.4 -4.6 C17.6 -5.3 18.6 -6.4 19.3 -7.1 C19 -5.9 18.5 -4.4 18 -3 C17.85 -2.3 17.7 -1.6 17.6 -1 C17 -0.2 16.3 0.1 15.4 0.15 C9.6 1 -1.4 1.05 -11.2 0.9 C-15.4 0.85 -18 0.1 -18.8 -1.4 C-19.2 -2.2 -19.3 -3.3 -19.2 -4.2 Z" />
                  {/* 舷侧板缝 ×2：跟着舷弧走的两条横笔，只做木板质感 */}
                  <path className="wb-scene__boat-seam" d="M-16.6 -2.05 C-12 -1.65 -5 -1.45 1 -1.55 C7 -1.65 12 -2 15.4 -2.65" />
                  <path className="wb-scene__boat-seam" d="M-14 -0.85 C-9.2 -0.5 -3 0.05 3 -0.05 C8 -0.15 12.2 -0.5 14.6 -1.05" />
                  {/* 穹顶苫布矮篷：底边坐在舷沿 −2.85，脊在 −5.9 */}
                  <path className="wb-scene__boat-awning" d="M-7.2 -2.8 C-7.6 -4.6 -6.2 -5.8 -2.4 -5.9 C1.5 -6 4.2 -4.9 4.7 -2.85 Z" />
                  {/* 四根篷骨：竹骨唯一的线索，近看是骨、远看是极淡的纹理 */}
                  <path className="wb-scene__boat-rib" d="M-5.5 -2.9 C-5.8 -4.1 -5.4 -5.1 -4.6 -5.55" />
                  <path className="wb-scene__boat-rib" d="M-3.1 -2.9 C-3.4 -4.2 -2.7 -5.3 -2.1 -5.75" />
                  <path className="wb-scene__boat-rib" d="M-0.3 -2.9 C-0.3 -4.3 0.2 -5.5 0.8 -5.85" />
                  <path className="wb-scene__boat-rib" d="M2.3 -2.9 C2.5 -4 2.9 -4.8 3.3 -5.1" />
                  {/* 篷檐压线：把篷与船身切开的那一笔，删掉就糊成一坨 */}
                  <path className="wb-scene__boat-eave" d="M-7.15 -2.9 L4.65 -2.9" />
                  {/* 橹绳：一圈套在橹杭上，绳尾沿舷沿向里收 */}
                  <path className="wb-scene__boat-rope" d="M-17.9 -3.35 C-17 -3.95 -16.5 -3 -17.3 -2.65 C-18.05 -2.35 -18.45 -3.2 -17.65 -3.35" />
                  <path className="wb-scene__boat-rope" d="M-16.9 -2.6 C-16.35 -2.25 -15.95 -2.05 -15.5 -1.95" />
                  {/* 篷边渔火：灯挑从篷肩 (3.5,−5.35) 伸出，灯笼挂在篷檐右肩之外。
                      光晕半径从旧版的 34 收到 12，避免大光晕叠水纹形成淡黄色斑 */}
                  <path className="wb-scene__boat-lamp-arm" d="M3.5 -5.35 L6.4 -5.35" />
                  <path className="wb-scene__boat-lamp-arm" d="M6.4 -5.35 L6.4 -5.15" />
                  <circle className="wb-scene__boat-glow" cx="6.43" cy="-4.05" r="12" fill="url(#wb-boat-glow)" />
                  <rect className="wb-scene__boat-lantern" x="5.3" y="-5.15" width="2.25" height="2.2" rx="0.55" />
                  <path className="wb-scene__boat-lamp-cap" d="M5.4 -5.03 L7.45 -5.03" />
                  <path className="wb-scene__boat-lamp-cap" d="M5.45 -3.07 L7.4 -3.07" />
                </g>
              </g>
            </g>
            {/* 水面倒影：只跟横向漂移，不跟着升沉上下跳；
                船升高时压暗、落下时提亮，读成"灯影被船压住又松开" */}
            <g className="wb-scene__boat-reflection">
              {/* 三段由宽到窄的暖色短线，越往下越淡 */}
              <g className="wb-scene__boat-shimmer">
                <rect x="4.28" y="1.9" width="4.8" height="1.2" rx="0.6" />
                <rect x="4.88" y="4.2" width="3.6" height="1" rx="0.5" />
                <rect x="5.38" y="6.4" width="2.6" height="0.9" rx="0.45" />
              </g>
            </g>
          </g>
        </g>

        {/* 远山剪影：对岸一层更淡更灰的低矮山脊，只做色块不做细节 */}
        <path
          className="wb-scene__far-ridge"
          d={`M0 ${WATERLINE} L0 540 Q120 512 240 536 Q340 554 440 528 Q540 504 640 532 Q740 556 840 536 Q940 512 1040 534 Q1140 556 1240 534 Q1340 512 1440 536 Q1520 554 1600 540 L1600 ${WATERLINE} Z`}
        />

        {/* 山体本体：压在水线之上 */}
        <MountainShapes />
      </svg>

      {/* 独立枝干丛（高处远景档）：左右各一丛，从画面上缘/外侧以更细更淡的枝条伸入，
          与现有两棵主树不属于同一主干，渲染在现有枝条之前，形成更远的一层 */}
      <svg className="wb-scene__branch wb-scene__branch--left-high" viewBox="0 0 360 560" preserveAspectRatio="xMinYMin meet" focusable="false">
        <BranchCluster paint={LEFT_HIGH_PAINT} blossoms={LEFT_HIGH_TREE.blossoms} prefix="l-high" far blossomOpacity={0.62} />
      </svg>
      <svg className="wb-scene__branch wb-scene__branch--right-high" viewBox="0 0 360 560" preserveAspectRatio="xMaxYMin meet" focusable="false">
        <BranchCluster paint={RIGHT_HIGH_PAINT} blossoms={RIGHT_HIGH_TREE.blossoms} prefix="r-high" far blossomOpacity={0.62} />
      </svg>

      {/* 独立枝干丛（中低处中景档）：左右各一丛，枝条更粗、花朵更大一点，
          整组透明度 0.88 / 0.92，位置比高位组低、比现有前景树远 */}
      <svg className="wb-scene__branch wb-scene__branch--left-low" viewBox="0 0 360 560" preserveAspectRatio="xMinYMax meet" focusable="false">
        <BranchCluster paint={LEFT_LOW_PAINT} blossoms={LEFT_LOW_TREE.blossoms} prefix="l-low" branchOpacity={0.88} blossomOpacity={0.92} />
      </svg>
      <svg className="wb-scene__branch wb-scene__branch--right-low" viewBox="0 0 360 560" preserveAspectRatio="xMaxYMax meet" focusable="false">
        <BranchCluster paint={RIGHT_LOW_PAINT} blossoms={RIGHT_LOW_TREE.blossoms} prefix="r-low" branchOpacity={0.88} blossomOpacity={0.92} />
      </svg>

      {/* 左侧樱花枝：从左缘中低处横向入画、向右上折线攀升，与右侧自右上角垂下形成落差。
          背景枝先铺（更细更淡、更靠上），前景主枝与花朵压在上面；每一棵树内部都按
          "子先父后"绘制，父枝描边盖住子枝起点，接头处不留缝 */}
      <svg className="wb-scene__branch wb-scene__branch--left" viewBox="0 0 520 900" preserveAspectRatio="xMinYMax meet" focusable="false">
        <g className="wb-scene__branch-far" fill="none">
          {LEFT_FAR_PAINT.map((segment) => (
            <path key={segment.id} strokeWidth={segment.width} d={toPathData(segment.points)} />
          ))}
        </g>
        <g opacity="0.62">
          {LEFT_FAR_TREE.blossoms.map((blossom, index) => (
            <BlossomMark key={`l-far-${blossom.segmentId}-${blossom.t}-${index}`} {...blossom} />
          ))}
        </g>
        <BranchPaths segments={LEFT_PAINT} />
        {LEFT_TREE.blossoms.map((blossom, index) => (
          <BlossomMark key={`l-${blossom.segmentId}-${blossom.t}-${index}`} {...blossom} />
        ))}
      </svg>

      {/* 右侧樱花枝：同样先铺背景枯枝，再压前景主枝与花朵。
          枝条由分段 stroke 拼成，宽度沿主干到末梢单调递减 */}
      <svg className="wb-scene__branch" viewBox="0 0 520 900" preserveAspectRatio="xMaxYMin meet" focusable="false">
        <g className="wb-scene__branch-far" fill="none">
          {RIGHT_FAR_PAINT.map((segment) => (
            <path key={segment.id} strokeWidth={segment.width} d={toPathData(segment.points)} />
          ))}
        </g>
        <g opacity="0.62">
          {RIGHT_FAR_TREE.blossoms.map((blossom, index) => (
            <BlossomMark key={`r-far-${blossom.segmentId}-${blossom.t}-${index}`} {...blossom} />
          ))}
        </g>
        <BranchPaths segments={RIGHT_PAINT} />
        {RIGHT_TREE.blossoms.map((blossom, index) => (
          <BlossomMark key={`r-${blossom.segmentId}-${blossom.t}-${index}`} {...blossom} />
        ))}
      </svg>

      {/* 花瓣入水涟漪：整层只铺在水线以下（高度与 .wb-scene__water 一致），
          每个占位点由 effect 在初始化 / resize 时写 left，并挂上与花瓣同周期的五圈动画：
          外圈、内圈、两圈更宽更淡的同心弧、入水瞬间的亮面短闪。
          没有落到水面的花瓣不会挂动画，占位点保持 opacity:0 */}
      <div className="wb-scene__ripples" ref={rippleLayer}>
        {ALL_PETALS.map((_petal, key) => (
          <span className="wb-scene__ripple" key={key}>
            <i className="wb-scene__ripple-ring" />
            <i className="wb-scene__ripple-ring" />
            <i className="wb-scene__ripple-ring wb-scene__ripple-ring--wide" />
            <i className="wb-scene__ripple-ring wb-scene__ripple-ring--wider" />
            <i className="wb-scene__ripple-ring wb-scene__ripple-flash" />
          </span>
        ))}
      </div>

      {/* 湖面漂浮花瓣：常驻在水上的花瓣本体 + 每片自带的静态椭圆水纹 + 每隔一段时间
          原地轻轻荡开的一圈。与上面的落瓣涟漪互不取代：那一层是入水那一下，这一层是
          一直漂着的花瓣；DOM 在涟漪之后，同层时压在涟漪之上。移动端只留 10 片（类名 --sm） */}
      <div className="wb-scene__floaters">
        {FLOATING_PETALS.map((petal) => (
          <span
            className={`wb-scene__float${petal.mobile ? " wb-scene__float--sm" : ""}`}
            // 纯装饰，key 取自排布表的 stable 下标
            key={petal.key}
            style={floatStyle(petal)}
          >
            <i className="wb-scene__float-pulse" />
            <span className="wb-scene__float-drift">
              <i className="wb-scene__float-ring" />
              <span className="wb-scene__float-body">
                <span className="wb-scene__float-shape" />
              </span>
            </span>
          </span>
        ))}
      </div>

      {/* 丹顶鹤：两只一前一后（同一份造型，后一只更小更淡、延时 3s、振翅相位错开）。
          外层沿单程航路飞向左上出画、不可见地折回起点，内层原地振翅。
          z-index 4 显式压在花瓣（3）之上，仍低于页脚（页脚在 .wb-home 上 z-index 2，
          场景整体是 z-index 0） */}
      <Crane variant="trail" />
      <Crane />

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

      {/* 左侧飘落花瓣：单独一组，起点、时长与延迟都与右侧错开，避免左右同拍 */}
      <div className="wb-scene__petals wb-scene__petals--left">
        {LEFT_PETALS.map((petal, index) => (
          <span
            className={`wb-scene__petal wb-scene__petal--${petal.path} wb-scene__petal--${petal.tone}`}
            // 同上：纯装饰，index 仅用于稳定 key
            // eslint-disable-next-line react/no-array-index-key
            key={index}
            style={petalStyle(petal)}
          >
            <span className="wb-scene__petal-inner" />
          </span>
        ))}
      </div>
    </div>
  );
}
