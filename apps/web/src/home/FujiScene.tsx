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

/** 一片羽毛：羽根沿翼后缘张开 width，两侧略带弧度，羽端收成一个尖点 */
function featherPath(root: [number, number], tip: [number, number], width: number): string {
  const [rx, ry] = root;
  const [tx, ty] = tip;
  const dx = tx - rx;
  const dy = ty - ry;
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * (width / 2);
  const ny = (dx / len) * (width / 2);
  const mx = rx + dx * 0.55;
  const my = ry + dy * 0.55;
  const round = (n: number) => Math.round(n * 10) / 10;
  const p = (x: number, y: number) => `${round(x)} ${round(y)}`;
  return (
    `M${p(rx + nx, ry + ny)} ` +
    `Q${p(mx + nx * 0.8, my + ny * 0.8)} ${p(tx, ty)} ` +
    `Q${p(mx - nx * 0.8, my - ny * 0.8)} ${p(rx - nx, ry - ny)} Z`
  );
}

type Feather = { root: [number, number]; tip: [number, number]; width: number };

/** 远翼翼尖：三片分开的羽片，长度与朝向逐片错开，靠近躯干的一段被躯干遮住 */
const FAR_TIP_FEATHERS: Feather[] = [
  { root: [36, 2.4], tip: [25.4, 0.6], width: 4.2 },
  { root: [33.2, 4.6], tip: [21.8, 3.6], width: 4.2 },
  { root: [30.6, 6.8], tip: [19, 7.6], width: 4 },
];

/** 近翼初级飞羽：沿翼后缘从翼尖向体侧逐根排布，羽端尖、长度与方向略有参差 */
const NEAR_PRIMARIES: Feather[] = [
  { root: [40, 54.8], tip: [24.6, 57.6], width: 3 },
  { root: [41.6, 52.8], tip: [25.8, 60.8], width: 3 },
  { root: [43.2, 50.8], tip: [28.4, 63.2], width: 3 },
  { root: [44.8, 48.8], tip: [32, 64.2], width: 3 },
  { root: [46.4, 46.8], tip: [35.8, 63], width: 2.8 },
];

/** 近翼次级飞羽：靠体侧的一组更短的白羽，压在初级飞羽根部上，形成层叠 */
const NEAR_SECONDARIES: Feather[] = [
  { root: [48.6, 44.4], tip: [43, 49.2], width: 4 },
  { root: [50.6, 41.8], tip: [45.4, 46.6], width: 4 },
  { root: [52.6, 39.4], tip: [47.8, 44.4], width: 3.8 },
];

/**
 * 仙鹤剪影（细化版）：朝右绘制，由 CSS `scaleX(-1)` 镜像成向左飞。
 *
 * 绘制顺序就是前后层次（先画的在下面）：
 * 腿脚 → 远翼 → 尾羽 → 颈 → 躯干（含明暗）→ 近翼 → 头颈细节。
 * - 躯干：多点控制的自绘轮廓——胸骨龙骨是最前凸点，胸到腹收进去、腹部圆而下垂，
 *   背线自肩向后逐渐下压，尾根一点收束并与尾羽衔接；体侧另压一道极轻的羽面影做纵深。
 * - 颈：先画、颈根压进胸口，由躯干覆盖接缝，颈根粗、向前上方引出，与胸口形成颈-胸夹角。
 * - 远翼：整组画在躯干之前，只有与躯干相交的根部被遮挡，其余轮廓完整；
 *   翼面分主羽面 + 三片分开的翼尖羽 + 两道羽轴 + 一道后缘分层线。
 * - 近翼：整组画在躯干之后（最上层），翼根搭在肩与体侧上、始终不被躯干切断；
 *   翼面分覆盖羽区（白）与飞羽区（墨黑）：前缘一道连续轮廓、五根逐根分离的初级飞羽、
 *   三根更短的次级飞羽压在其根部，羽间只用同色相极细线分界，另有一道极轻的翼下羽面影。
 * - 两翼都以肩点 (67,31) 为旋转轴，旋转时翼根只在肩窝里小幅摆动，不会穿进躯干。
 * - 头颈：独立头形 + 长喙 + 眼位 + 头顶红冠，颈上有向头部收束的墨色楔形。
 * - 腿脚：髋点收在腹线内侧，大腿—胫—脚趾三段，关节处折角，脚趾分开并向后收。
 * - 配色按参考图：白羽面、冷灰羽影、墨黑飞羽与尾羽、朱红顶冠、石板灰喙、墨色腿。
 *   白羽本身在浅蓝天空上不足 3:1，由 --crane-plume-edge 羽缘描边承担可辨性。
 */
function CraneSilhouette() {
  return (
    <svg className="wb-crane__svg" viewBox="0 0 120 72" focusable="false">
      {/* 腿脚：髋点收在腹线内侧（33/35,42 一带），先画，被躯干与近翼盖住根部 */}
      <path className="wb-crane__leg" d="M33 42 L21 47 L8 52 M8 52 L2 53.5 M8 52 L4 55" />
      <path className="wb-crane__leg" d="M35 42.8 L23 48.5 L12 55 M12 55 L6 56.5 M12 55 L8 58" />

      {/* 远翼：整体在躯干之下，只在与躯干相交处被遮挡；翼面 + 三片分开的翼尖羽 + 羽轴 */}
      <g className="wb-crane__wing wb-crane__wing--far">
        <path d="M67 29.6 C 61.4 22.6 54.4 15.2 47.4 9.4 C 43.2 6 39.4 3.2 36.2 1.8 L 30.4 6.8 C 33.8 9.6 37.6 13.4 42 17.6 C 47.8 23 55.6 27.8 67 31.4 Z" />
        {FAR_TIP_FEATHERS.map((feather) => (
          <path
            key={`far-${feather.tip[0]}-${feather.tip[1]}`}
            className="wb-crane__scale"
            d={featherPath(feather.root, feather.tip, feather.width)}
          />
        ))}
        <path className="wb-crane__feather" d="M60.6 26.4 C 54.6 20.8 48.2 15 41.8 9.8" />
        <path className="wb-crane__feather" d="M57 28.6 C 51.2 23.2 45.4 17.8 39.6 12.8" />
        <path className="wb-crane__feather" d="M43 18 C 47 21 51.8 24.2 57 26.6" />
      </g>

      {/* 尾羽：两短一长的白羽片从尾根向后收尖，羽缘带冷板岩描边；根部被躯干盖住，不断口 */}
      <path className="wb-crane__body" d="M31 37.8 L 18 35.5 L 19 38.5 L 32 41 Z" />
      <path className="wb-crane__body" d="M31 40.4 L 16 40.5 L 17.5 44 L 31 42.8 Z" />
      <path className="wb-crane__body" d="M30 42.8 L 18 46.5 L 20.5 49.5 L 32 44.2 Z" />

      {/* 脖子：先画，颈根（64,32.2 → 69.6,34.4）压进胸口，由躯干盖住接缝；
          上缘自肩陡起、中段外凸，下缘向胸骨前端斜落，与胸口形成颈-胸夹角 */}
      <path
        className="wb-crane__body"
        d="M64 32.2 C 65 26.2 71.5 21.2 78.5 17.8 C 83.5 15.5 88 15 91 15 L 91 19.6 C 87 20.6 83 22 79.2 24.4 C 75.2 27.4 71.6 30.6 69.6 34.4 C 69.2 35 68.9 35.2 68.8 35.2 Z"
      />
      {/* 颈上墨色楔形：贴着头部、只占颈前段约三分之一，向颈中收细 */}
      <path className="wb-crane__primary" d="M92.4 15.6 L 92.6 17.9 L 85.2 20.6 L 84.6 19.1 L 91.2 16.3 Z" />

      {/* 躯干：多点自绘轮廓。转折点依次为
          尾根 (28.5,39.8) → 后腰 (33.6,42.1) → 腹底 (47,44.6) → 胸腹转折 (59,43.5)
          → 龙骨下缘 (67.6,41.2) → 龙骨前凸 (71.3,36.4) → 胸前肩窝 (68.2,32.6)
          → 肩背 (59,29.8) → 背线向后下压 (43,31.3) → 回到尾根 */}
      <path
        className="wb-crane__body"
        d="M28.5 39.8 C 29.8 36.4 35.5 33.2 43 31.3 C 48 30 54 29.5 59 29.8 C 62.6 30.1 65.8 31.2 68.2 32.6 C 70.2 33.7 71.4 35 71.3 36.4 C 71.4 38.4 70 40.2 67.6 41.2 C 64 42.4 59 43.5 54 44 C 47 44.6 39 43.8 33.6 42.1 C 30.2 41.3 28.4 40.6 28.5 39.8 Z"
      />
      {/* 腹部明暗：沿胸骨下缘到腹底的窄条羽面影，交代腹线圆度 */}
      <path className="wb-crane__shade" d="M37 43.8 C 45 44.7 53 44.7 60 43 L 59 41.4 C 53 43.2 45 43.6 37.6 43 Z" />
      {/* 体侧收窄：肩胛到腰的一道极轻羽面影，让前后有纵深，不压成灰块 */}
      <path
        className="wb-crane__shade wb-crane__shade--soft"
        d="M58 33.7 C 52 34.5 46 35.9 40 37.9 C 36.6 39.1 33.8 40.3 31.7 41.7 L 34.2 42.2 C 36.6 40.8 39.4 39.6 43 38.4 C 49 36.2 54.6 34.9 58 34.5 Z"
      />
      {/* 颈后转折：浅灰细线交代颈根与胸口的体块分界 */}
      <path className="wb-crane__feather" d="M72 26 C 76.5 23 82 20.6 86.5 19.6" />

      {/* 近翼：画在躯干之后，压在身上；翼根（66,31.4 → 52.6,38.6）从肩搭到体侧，
          不会被躯干切断。翼面是翼根最宽、向翼尖收窄的楔形，后缘挂五根初级飞羽 + 三根次级飞羽 */}
      <g className="wb-crane__wing wb-crane__wing--near">
        <path d="M66 31.4 C 62.6 30.6 58.6 31.4 55.4 33.4 C 50.6 36.4 44.6 41.6 39.6 46.6 C 37.4 48.8 35.6 49.8 34.8 50.2 L 39.4 55.8 C 41.4 52.8 44 49.4 47 46.2 C 49.6 43.4 51.4 40.8 52.6 38.6 C 56 34.6 61 32.4 66 31.4 Z" />
        {/* 翼下厚度：贴着后缘内侧的一道极轻羽面影，交代覆羽压在飞羽上的落差 */}
        <path
          className="wb-crane__shade wb-crane__shade--soft"
          d="M40.8 54.4 C 43 51 45.8 47.6 49 44.6 C 51 42.6 52.4 40.8 53.4 39.4 L 51.8 38.6 C 50.8 40 49.4 41.6 47.6 43.4 C 44.6 46.4 42.2 49.8 40.2 53 Z"
        />
        {/* 覆羽分层：两道沿翼展方向的细线，交代内侧覆羽区 */}
        <path className="wb-crane__feather" d="M58.6 33.6 C 54.6 36.2 50.6 40.4 47 44.6" />
        <path className="wb-crane__feather" d="M56.2 32.6 C 52.4 35.4 48.4 39.6 45 43.8" />
        {/* 初级飞羽：逐根分离，羽端尖、长度与朝向递变，是翼尖最快的识别特征 */}
        {NEAR_PRIMARIES.map((feather) => (
          <path
            key={`near-primary-${feather.tip[0]}-${feather.tip[1]}`}
            className="wb-crane__primary"
            d={featherPath(feather.root, feather.tip, feather.width)}
          />
        ))}
        {/* 次级飞羽：压住初级飞羽根部的一组短白羽，边缘用细线而不是粗描边 */}
        {NEAR_SECONDARIES.map((feather) => (
          <path
            key={`near-secondary-${feather.tip[0]}-${feather.tip[1]}`}
            className="wb-crane__scale"
            d={featherPath(feather.root, feather.tip, feather.width)}
          />
        ))}
      </g>

      {/* 头颈：白羽头形 + 石板灰长喙 + 墨色眼位 + 头顶朱红冠（冠压在头顶，不留缝） */}
      <circle className="wb-crane__body" cx="94.5" cy="17.2" r="3.2" />
      <path className="wb-crane__beak" d="M96.9 14.8 L 116.8 12.2 L 117.2 13.4 L 97.6 18.6 Z" />
      <ellipse className="wb-crane__crown" cx="94.2" cy="14.6" rx="2.2" ry="0.95" transform="rotate(-12 94.2 14.6)" />
      <circle className="wb-crane__eye" cx="95.6" cy="17" r="0.8" />
    </svg>
  );
}

export function FujiScene() {
  return (
    <div className="wb-home__scene" aria-hidden="true">
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
