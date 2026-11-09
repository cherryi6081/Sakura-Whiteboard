import type { CSSProperties } from "react";

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

      <p className="wb-scene__caption">富士山下，樱花落时。</p>
    </div>
  );
}
