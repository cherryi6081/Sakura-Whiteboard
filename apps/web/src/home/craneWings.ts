import { cranePose, type CraneWingName } from "./cranePose";
import { waveTime } from "./waveField";

/**
 * SVG 分支的振翅：把 cranePose 的 roll / bend 逐帧写进两翼的**同名 CSS 变量**
 * （--crane-roll / --crane-bend，单位 deg），由 CSS 合成一次 rotate。
 * WebGL 分支写的是 uBend uniform 与 mesh.rotation.z，两端读的是同一个函数、同一个钟
 * （waveField.waveTime），所以同一时刻翼尖角逐帧一致。
 *
 * 为什么不是 CSS 关键帧：关键帧只能表达「一条固定曲线」，塞不进二阶弹簧的相位滞后，
 * 也没法和 WebGL 共用同一份数。这里只写 4 个元素的 8 个自定义属性，
 * 不碰路径 d、不改 DOM 结构。
 */

/** 后鹤的振翅相位（s），与 WebGL 的 TRAIL_WING_PHASE / CSS 的 -0.31s 是同一个数 */
const TRAIL_WING_PHASE = 0.31;

/** 角度变化小于这个值就不写（≈0.02° ≈ 0.02px 翼尖位移），把 style 失效降到每几帧一次 */
const WRITE_EPSILON = 0.02;

type WingTarget = {
  node: SVGGElement;
  wing: CraneWingName;
  phase: number;
  roll: number | null;
  bend: number | null;
};

/**
 * 挂在场景子树上（首页与登录页各一只/两只鹤，互不影响）。
 * reduce 下不启动：两翼停在基准姿态（--crane-roll / --crane-bend 缺省 0），与改造前一致。
 */
export function mountCraneWings(root: ParentNode): () => void {
  if (typeof window === "undefined") return () => {};
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return () => {};

  const nodes = root.querySelectorAll<SVGGElement>(".wb-crane__wing");
  if (!nodes.length) return () => {};

  const targets: WingTarget[] = [];
  for (const node of nodes) {
    targets.push({
      node,
      wing: node.classList.contains("wb-crane__wing--far") ? "far" : "near",
      phase: node.closest(".wb-scene__crane--trail") ? TRAIL_WING_PHASE : 0,
      roll: null,
      bend: null,
    });
  }

  let raf = 0;
  const tick = () => {
    const t = waveTime();
    for (const target of targets) {
      const pose = cranePose(t + target.phase, target.wing);
      if (target.roll === null || Math.abs(pose.roll - target.roll) >= WRITE_EPSILON) {
        target.roll = pose.roll;
        target.node.style.setProperty("--crane-roll", pose.roll.toFixed(3));
      }
      if (target.bend === null || Math.abs(pose.bend - target.bend) >= WRITE_EPSILON) {
        target.bend = pose.bend;
        target.node.style.setProperty("--crane-bend", pose.bend.toFixed(3));
      }
    }
    raf = requestAnimationFrame(tick);
  };

  raf = requestAnimationFrame(tick);
  return () => {
    if (raf) cancelAnimationFrame(raf);
    for (const target of targets) {
      target.node.style.removeProperty("--crane-roll");
      target.node.style.removeProperty("--crane-bend");
    }
  };
}
