import type { CSSProperties } from "react";

/**
 * 首页右侧场景：浅蓝富士山 + 飘落樱花。
 *
 * 方案选择：花瓣用 **纯 CSS transform/opacity**（16 个元素，桌面端），不用 canvas。
 * 理由：花瓣数量少，CSS 动画由合成器在 GPU 上跑，不占主线程；canvas 需要 rAF 循环，
 * 在这个量级反而更重，也难做 prefers-reduced-motion 与响应式降级。
 *
 * 每个花瓣由两层元素组成：外层负责下落（translate3d Y + opacity），
 * 内层负责横向摆动与旋转（alternate 往复），两层都用 transform/opacity，
 * 不触发 layout/paint。所有参数写死在常量里，避免运行时随机导致每次渲染抖动。
 */

type Petal = {
  /** 水平起点（%） */
  left: number;
  /** 花瓣宽度（px），高度按比例算 */
  size: number;
  /** 下落周期（s），差异制造景深 */
  duration: number;
  /** 负延迟让页面加载时花瓣已经散布在空中 */
  delay: number;
  /** 横向摆动幅度（px） */
  drift: number;
  /** 摆动周期（s） */
  sway: number;
  /** 最大旋转角度（deg） */
  rotate: number;
  /** 透明度，远处更淡 */
  opacity: number;
  tone: "light" | "mid" | "deep";
};

const PETALS: Petal[] = [
  { left: 4, size: 14, duration: 23, delay: -4, drift: 6, sway: 7.5, rotate: 160, opacity: 0.55, tone: "light" },
  { left: 12, size: 20, duration: 17, delay: -11, drift: 22, sway: 5.2, rotate: 210, opacity: 0.9, tone: "mid" },
  { left: 19, size: 12, duration: 26, delay: -19, drift: 4, sway: 8.4, rotate: 120, opacity: 0.45, tone: "light" },
  { left: 27, size: 18, duration: 19, delay: -2, drift: 18, sway: 6.1, rotate: 190, opacity: 0.8, tone: "deep" },
  { left: 34, size: 15, duration: 21, delay: -14, drift: 12, sway: 4.8, rotate: 240, opacity: 0.7, tone: "mid" },
  { left: 41, size: 22, duration: 15, delay: -7, drift: 26, sway: 5.6, rotate: 200, opacity: 0.85, tone: "mid" },
  { left: 47, size: 13, duration: 28, delay: -22, drift: 3, sway: 9.2, rotate: 150, opacity: 0.4, tone: "light" },
  { left: 54, size: 19, duration: 18, delay: -5, drift: 20, sway: 6.4, rotate: 220, opacity: 0.88, tone: "deep" },
  { left: 61, size: 17, duration: 22, delay: -16, drift: 14, sway: 5.4, rotate: 170, opacity: 0.75, tone: "mid" },
  { left: 68, size: 12, duration: 25, delay: -9, drift: 5, sway: 8.8, rotate: 130, opacity: 0.5, tone: "light" },
  { left: 74, size: 21, duration: 16, delay: -1, drift: 24, sway: 4.6, rotate: 230, opacity: 0.92, tone: "mid" },
  { left: 81, size: 15, duration: 20, delay: -13, drift: 16, sway: 7.2, rotate: 185, opacity: 0.72, tone: "deep" },
  { left: 87, size: 18, duration: 24, delay: -6, drift: 10, sway: 6.8, rotate: 150, opacity: 0.62, tone: "light" },
  { left: 92, size: 13, duration: 27, delay: -18, drift: 7, sway: 9.6, rotate: 200, opacity: 0.48, tone: "mid" },
  { left: 96, size: 20, duration: 14, delay: -3, drift: 28, sway: 4.4, rotate: 245, opacity: 0.9, tone: "deep" },
  { left: 23, size: 11, duration: 30, delay: -24, drift: 2, sway: 10.5, rotate: 110, opacity: 0.35, tone: "light" },
];

function petalStyle(petal: Petal): CSSProperties {
  return {
    "--p-left": `${petal.left}%`,
    "--p-size": `${petal.size}px`,
    "--p-duration": `${petal.duration}s`,
    "--p-delay": `${petal.delay}s`,
    "--p-drift": `${petal.drift}px`,
    "--p-sway": `${petal.sway}s`,
    "--p-rotate": `${petal.rotate}deg`,
    "--p-opacity": petal.opacity,
  } as CSSProperties;
}

export function FujiScene() {
  return (
    <div className="wb-home__scene" aria-hidden="true">
      <svg className="wb-scene__mountains" viewBox="0 0 900 700" preserveAspectRatio="xMidYMax slice" focusable="false">
        {/* 远山：最淡，压在主峰后面 */}
        <path
          className="wb-scene__range"
          d="M0 566 L78 474 L150 508 L232 432 L310 502 L392 458 L470 532 L560 482 L650 526 L722 470 L800 522 L900 492 L900 700 L0 700 Z"
        />
        {/* 山顶雾光：放在主峰之前，只做背景光晕，不遮挡雪顶 */}
        <ellipse className="wb-scene__mist" cx="486" cy="212" rx="248" ry="42" />
        {/* 主峰：左右两侧内凹的火山轮廓 */}
        <path
          className="wb-scene__fuji"
          d="M168 700 C 252 612 352 522 432 300 C 452 248 466 204 486 148 C 506 204 520 248 540 300 C 620 522 720 612 802 700 Z"
        />
        {/* 右侧阴影面：增加体积感 */}
        <path
          className="wb-scene__fuji-shadow"
          d="M486 148 C 506 204 520 248 540 300 C 620 522 720 612 802 700 L 566 700 C 566 566 520 384 486 148 Z"
        />
        {/* 雪顶：沿山脊向下收窄，底部做出不规则边缘 */}
        <path
          className="wb-scene__snow"
          d="M486 148 C 506 204 520 248 540 300 L 528 330 L 512 306 L 496 334 L 480 304 L 464 328 L 448 310 C 436 256 458 204 486 148 Z"
        />
        {/* 前景山脚：压暗底部，让场景与页面底色衔接 */}
        <path
          className="wb-scene__foothill"
          d="M0 700 C 130 642 268 682 404 652 C 540 622 680 672 900 636 L 900 700 Z"
        />
      </svg>

      <div className="wb-scene__petals">
        {PETALS.map((petal, index) => (
          <span
            className={`wb-scene__petal wb-scene__petal--${petal.tone}`}
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
