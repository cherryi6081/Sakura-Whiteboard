import type { CSSProperties } from "react";
import {
  LEFT_FAR_PAINT,
  LEFT_FAR_TREE,
  LEFT_PAINT,
  LEFT_TREE,
  RIGHT_FAR_PAINT,
  RIGHT_FAR_TREE,
  RIGHT_PAINT,
  RIGHT_TREE,
  toPathData,
  type Blossom,
  type BranchSegment,
} from "./fujiBranches";

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
  { left: 95, top: 18, size: 13, dur: 25, delay: -18, spin: 0.8, opacity: 0.45, tone: "light", path: "c" },
  { left: 68, top: 31, size: 11, dur: 28, delay: -23, spin: 1.2, opacity: 0.34, tone: "light", path: "a" },
  { left: 76, top: 34, size: 16, dur: 19, delay: -13, spin: 1.05, opacity: 0.64, tone: "mid", path: "c" },
  { left: 84, top: 37, size: 13, dur: 24, delay: -5, spin: 0.9, opacity: 0.52, tone: "light", path: "a" },
  { left: 91, top: 32, size: 18, dur: 17, delay: -15, spin: 1.15, opacity: 0.72, tone: "mid", path: "a" },
  { left: 96, top: 40, size: 15, dur: 22, delay: -7, spin: 1, opacity: 0.6, tone: "deep", path: "b" },
];

/**
 * 左侧飘落花瓣：与右侧同属一套花瓣与动画，但起点集中在左半屏、数量更少（10 片 vs 26 片），
 * 时长与延迟刻意不与右侧重合（右侧多为整数秒的整数倍负延迟），摆动方向统一向右下，
 * 避免从左侧落下时立刻被甩出画面。路径只用 b（右下弧）与 d（先右后回摆的缓 S 弧）。
 */
const LEFT_PETALS: Petal[] = [
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
 * 倒影分段：[水线以下的 y 起点, 高度, 横向错位, 纵向压缩比, 明度]。
 * 每段都镜像整座山，再裁到自己那一条横带 —— 相邻段横向错开，
 * 交界处就出现水面常见的错位台阶；越往下压缩比越小、越淡。
 */
const REFLECTION_BANDS = [
  { id: "wb-ref-0", y: 566, height: 100, dx: 0, scale: 0.72, opacity: 0.46 },
  { id: "wb-ref-1", y: 666, height: 84, dx: 10, scale: 0.66, opacity: 0.33 },
  { id: "wb-ref-2", y: 750, height: 96, dx: -14, scale: 0.58, opacity: 0.22 },
];

/** 静态水面波纹：[x, y, 宽度, 不透明度]，只有形状没有动画；靠近水线的更亮更长，往下逐渐变细变淡 */
const RIPPLES: Array<[number, number, number, number]> = [
  [120, 596, 148, 0.62],
  [430, 612, 112, 0.44],
  [760, 600, 168, 0.55],
  [1080, 618, 132, 0.4],
  [1330, 606, 118, 0.48],
  [236, 690, 132, 0.38],
  [620, 706, 158, 0.34],
  [1010, 684, 120, 0.3],
  [1288, 700, 138, 0.32],
  [150, 792, 108, 0.26],
  [540, 806, 150, 0.24],
  [980, 788, 128, 0.22],
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

function petalStyle(petal: Petal): CSSProperties {
  const { dir, left, right } = PETAL_SWAY[petal.path];
  // 左右各留 3% 余量：花瓣中心始终在 3%–97% 之间
  const roomLeft = Math.max(0, petal.left - 3);
  const roomRight = Math.max(0, 97 - petal.left);
  const limit = Math.min(left > 0 ? roomLeft / left : Infinity, right > 0 ? roomRight / right : Infinity);
  const base = petal.path === "a" ? 28 : petal.path === "b" ? 24 : petal.path === "c" ? 14 : 10;
  const sway = dir * Math.min(base, limit);
  // 终点统一落在 92% 高度：整段轨迹都在视口内，透明度先归零再结束，不会被底部裁断
  const fall = Math.max(20, 92 - petal.top);
  return {
    "--p-top": `${petal.top}%`,
    "--p-left": `${petal.left}%`,
    "--p-size": `${petal.size}px`,
    "--p-dur": `${petal.dur}s`,
    "--p-delay": `${petal.delay}s`,
    "--p-spin": petal.spin,
    "--p-opacity": petal.opacity,
    "--p-sway": `${+sway.toFixed(2)}vw`,
    "--p-fall": `${+fall.toFixed(2)}vh`,
  } as CSSProperties;
}

export function FujiScene() {
  return (
    <div className="wb-home__scene" aria-hidden="true">
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
            <stop offset="50%" className="wb-scene__ref-stop-1" />
            <stop offset="100%" className="wb-scene__ref-stop-2" />
          </linearGradient>
          {REFLECTION_BANDS.map((band) => (
            <clipPath id={band.id} key={band.id}>
              <rect x="-140" y={band.y} width="1880" height={band.height} />
            </clipPath>
          ))}
        </defs>

        {/* 湖面：从水线一直铺到画面底边 */}
        <rect x="0" y={WATERLINE} width="1600" height={900 - WATERLINE} fill="url(#wb-lake-grad)" />

        {/* 倒影：整座山连同雪顶垂直镜像，分三段各自横向错位 + 纵向压缩 + 降低明度，
            段与段之间自然形成水面错位；越往下压缩越狠、越淡 */}
        {REFLECTION_BANDS.map((band) => (
          <g clipPath={`url(#${band.id})`} key={band.id}>
            <g
              className="wb-scene__reflection"
              opacity={band.opacity}
              transform={`translate(${band.dx} 0) matrix(1 0 0 ${-band.scale} 0 ${WATERLINE * (1 + band.scale)})`}
            >
              <MountainShapes />
            </g>
          </g>
        ))}

        {/* 水面加深层：倒影越往下越淡，最终融进湖色 */}
        <rect x="0" y={WATERLINE} width="1600" height={900 - WATERLINE} fill="url(#wb-ref-fade)" />

        {/* 静态横向波纹与反光，不做动画、不引滤镜 */}
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
        <rect className="wb-scene__lake-horizon" x="0" y={WATERLINE - 1} width="1600" height="2.4" />

        {/* 山体本体：压在水线之上 */}
        <MountainShapes />
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
