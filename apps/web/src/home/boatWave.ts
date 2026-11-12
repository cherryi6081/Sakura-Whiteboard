import { sampleWave, waveTime } from "./waveField";

/**
 * 小舟随浪：把 CSS 关键帧的 heave / tilt 换成波场驱动（见 waveField.ts）。
 *
 * 分工（一层只做一件事，互不抵消）：
 *   - drift：横向漂移，仍是 CSS 动画（与浪无关，41.3s）；
 *   - heave：整船升沉 = 波面在船中的高度；
 *   - tilt：俯仰 = 波面在船中沿 x 的斜率 atan(∂h/∂x)，绕水线中点转；
 *   - swell 首/中/尾三段：波面相对船身弦线的**二阶弯曲残差**，
 *     分别加在船头灯组、中段篷组、船尾橹组上。残差不进船身路径 d，
 *     只做 transform，单帧开销与一段 translate 相同。
 *
 * 单位：锚点与采样点在舞台坐标（与 SVG 一致），写入 DOM 前统一除以 scale
 * 换成船的局部单位（局部 1 单位 = 4 舞台单位，见 FujiScene 的 scale(4)）。
 */

/** 与 FujiScene 的 <g className="wb-scene__boat" transform="translate(1272 722) scale(4)"> 同一处真值 */
export const BOAT_ANCHOR = { x: 1272, y: 722, scale: 4 } as const;

/** 船身首柱 / 尾舷的局部 x（取自 .wb-scene__boat-hull 的路径端点） */
const HULL_BOW = 19.3;
const HULL_STERN = -19.2;

const MID_X = BOAT_ANCHOR.x;
const BOW_X = BOAT_ANCHOR.x + HULL_BOW * BOAT_ANCHOR.scale;
const STERN_X = BOAT_ANCHOR.x + HULL_STERN * BOAT_ANCHOR.scale;
const SAMPLE_Y = BOAT_ANCHOR.y;

/**
 * 残差折减与上限：全量残差在主浪（λ≈419）上能到 1.2 舞台单位，
 * 直接贴到舱篷/橹上会和刚性船身出现可见缝隙。折到 0.35 并夹在 ±0.45 舞台单位
 * （≈0.45px @1440），读起来是船身在浪里轻微“屈”一下，而不是零件错位。
 */
const FLEX = 0.35;
const FLEX_LIMIT = 0.45;

const clampAbs = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value));

/**
 * 挂到某棵场景子树上（首页与登录页各有一份小舟，互不影响）。
 * reduce 下不启动 rAF：船停在基准姿态，与 CSS 的 reduce 分支一致。
 */
export function mountBoatWave(root: ParentNode): () => void {
  const boat = root.querySelector<SVGGElement>(".wb-scene__boat");
  if (!boat) return () => {};
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return () => {};

  const heave = boat.querySelector<SVGGElement>(".wb-scene__boat-heave");
  const tilt = boat.querySelector<SVGGElement>(".wb-scene__boat-tilt");
  const bow = boat.querySelectorAll<SVGGElement>(".wb-scene__boat-swell-bow");
  const mid = boat.querySelectorAll<SVGGElement>(".wb-scene__boat-swell-mid");
  const stern = boat.querySelectorAll<SVGGElement>(".wb-scene__boat-swell-stern");
  if (!heave || !tilt) return () => {};

  // 三段残差是缓慢的二阶量，逐帧变化远小于 0.01 局部单位（≈0.036px @1440）时跳过写入：
  // 把这三层的 style 失效从每帧降到每几帧一次，肉眼无差
  const lastMove = new Map<SVGGElement, number>();
  const move = (nodes: NodeListOf<SVGGElement>, localY: number) => {
    const transform = `translateY(${localY.toFixed(3)}px)`;
    for (const node of nodes) {
      const prev = lastMove.get(node);
      if (prev !== undefined && Math.abs(prev - localY) < 0.01) continue;
      lastMove.set(node, localY);
      node.style.transform = transform;
    }
  };

  let raf = 0;

  const tick = () => {
    const t = waveTime();
    const center = sampleWave(MID_X, SAMPLE_Y, t);
    const head = sampleWave(BOW_X, SAMPLE_Y, t);
    const tail = sampleWave(STERN_X, SAMPLE_Y, t);

    // 俯仰跟着船中的斜率：正斜率（x 越大水面越低，屏幕 y 向下）→ 船头向下 → 正角度
    const pitch = (Math.atan(center.slopeX) * 180) / Math.PI;
    heave.style.transform = `translateY(${(center.height / BOAT_ANCHOR.scale).toFixed(3)}px)`;
    tilt.style.transform = `rotate(${pitch.toFixed(3)}deg)`;

    // 刚性船身只能是一条弦：把首/尾的实际波高减去弦线在同一 x 上的高度，剩的就是弯曲量
    const chordBow = center.height + (BOW_X - MID_X) * center.slopeX;
    const chordStern = center.height + (STERN_X - MID_X) * center.slopeX;
    const bowResidual = clampAbs((head.height - chordBow) * FLEX, FLEX_LIMIT);
    const sternResidual = clampAbs((tail.height - chordStern) * FLEX, FLEX_LIMIT);
    // 中段相对首尾连线（桁）的偏差：船中比两端更“鼓”时篷子略抬
    const midResidual = clampAbs(
      (center.height - (head.height + tail.height) / 2) * FLEX,
      FLEX_LIMIT,
    );

    move(bow, bowResidual / BOAT_ANCHOR.scale);
    move(mid, midResidual / BOAT_ANCHOR.scale);
    move(stern, sternResidual / BOAT_ANCHOR.scale);

    raf = requestAnimationFrame(tick);
  };

  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}
