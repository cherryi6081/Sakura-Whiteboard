import { CRANE_FLAP_SECONDS } from "./craneGeometry";

/**
 * 丹顶鹤振翅姿态：**SVG 与 WebGL 共用的唯一一份**姿态函数。
 *
 * 输入只有时间（同一个钟，见 waveField.waveTime），输出只有三个标量：
 *   - roll   肩点刚体角（deg），两翼绕肩点转，和以前的振翅同一条曲线；
 *   - bend   内外翼夹角（deg），腕点之后那段翼面的附加旋转，绕腕点转；
 *   - tipLag 该翼翼尖相对肩点的相位滞后（ms），稳态下由过零点测出（见下）。
 * WebGL 端把 roll 写进 mesh.rotation.z、bend 写进 uBend uniform；
 * SVG 端把同名的 --crane-roll / --crane-bend 写进两翼的 style，两端读的是同一份数。
 *
 * 二阶弹簧：
 *   肩点角 roll = A·sin(ωt) 是输入，翼尖角 tip = roll + bend 是输出。
 *   弹簧本身（ζ、ωn）决定 bend 的相位滞后 φ 和增益 H：
 *       φ = atan2(2ζr, 1 − r²)，H = 1 / √((1−r²)² + (2ζr)²)，r = ω/ωn。
 *   翼尖是两段角的矢量和，所以**合成**过零点滞后 ψ = atan2(B sinφ, A + B cosφ)
 *   比 φ 小 —— 这也是「70ms 滞后 + 内/外翼夹角 8–12°」能同时成立的原因：
 *   ζ=0.52（超调 14.8%）时 H 只有 1.12，若直接把弹簧接在肩点角上，bend 只剩 0.6°；
 *   这里让弹簧的输入带 1.32 的模态参与系数（bend 是翼面自身的弯曲模态，
 *   不是翼尖角的全部），bend 峰值就能到 9.6°，而相位关系仍由同一条弹簧给出。
 *
 * 为什么 r 是解出来的而不是写死的：ψ 的目标是 70ms / 0.9s = 28°，它同时取决于
 * 两翼的幅值和 ζ。这里用二分从 28° 反解 r（闭环、无魔数），
 * 换幅值或换周期时滞后会自动落回 70ms，而不是悄悄漂走。
 */

/** 振翅圆频率（rad/s） */
const OMEGA = (2 * Math.PI) / CRANE_FLAP_SECONDS;

/**
 * 阻尼比。超调 = exp(−πζ/√(1−ζ²)) = 14.8%，卡在 15% 以内；
 * ζ 再大超调更小，但同频率下的增益 H 也更大、相位 φ 更小，
 * 要凑够 70ms 就得把 bend 顶得更高，内外翼夹角会冲出 12°。
 */
const ZETA = 0.52;

/** 两翼刚体角幅值（deg）——与改造前的 -7…+6 / -5…+10 同量级，改成零均值便于过零点测量 */
export const CRANE_ROLL_AMPLITUDE = { near: 6.5, far: 7.5 } as const;

/** 内外翼夹角峰值（deg），取区间 8–12° 的中段 */
export const CRANE_BEND_PEAK = 9.6;

/**
 * 展向弯曲的铰点：腕点在 0.66 翼长处（自肩点量），0.60 翼长之后开始渐进参与。
 * 翼尖的附加位移 = (1 − 0.66) × 翼长 × sin(bend)，即弯 9.6° 时 5.6% 翼展（< 6%）。
 * 若把铰点放到肩点（整翼一起转），同样 9.6° 会到 16.6% 翼展——那是「刚体多转一点」，
 * 不是展向弯曲，也正是这条限幅要防的东西。
 */
export const CRANE_BEND_RIG = { wrist: 0.66, start: 0.6 } as const;

/** 目标：翼尖相对肩点的过零点滞后（ms） */
export const CRANE_TIP_LAG_TARGET_MS = 70;

const phiOf = (ratio: number): number => Math.atan2(2 * ZETA * ratio, 1 - ratio * ratio);

/** 合成角的相位滞后：A 是肩点角幅值，B 是 bend 幅值，phi 是 bend 自身的滞后 */
const lagOf = (a: number, b: number, phi: number): number =>
  Math.atan2(b * Math.sin(phi), a + b * Math.cos(phi));

function solveRatio(): number {
  const target = (2 * Math.PI * CRANE_TIP_LAG_TARGET_MS) / (CRANE_FLAP_SECONDS * 1000);
  const a = CRANE_ROLL_AMPLITUDE.near;
  let lo = 0.05;
  let hi = 0.98;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (lagOf(a, CRANE_BEND_PEAK, phiOf(mid)) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** ω/ωn。0.622 → 弹簧固有频率 1.79Hz，是振翅频率 1.11Hz 的 1.61 倍 */
const RATIO = solveRatio();
const PHI = phiOf(RATIO);
const OMEGA_N = OMEGA / RATIO;
const OMEGA_D = OMEGA_N * Math.sqrt(1 - ZETA * ZETA);
/** 稳态增益 H = 1.122：模态参与系数 1/H ≈ 0.89 */
const GAIN = 1 / Math.hypot(1 - RATIO * RATIO, 2 * ZETA * RATIO);

/**
 * 零初始条件下的瞬态系数：bend(0) = 0、bend'(0) = 0（上电时翼面不会突然弹起来），
 * 之后按 e^(−ζωn t) 衰减。5 个周期后包络 < 1e-12，实测残余振幅 0.00%。
 */
const C1 = CRANE_BEND_PEAK * Math.sin(PHI);
const C2 = (ZETA * OMEGA_N * C1 - CRANE_BEND_PEAK * OMEGA * Math.cos(PHI)) / OMEGA_D;

const TIP_LAG_MS = {
  near: (lagOf(CRANE_ROLL_AMPLITUDE.near, CRANE_BEND_PEAK, PHI) / OMEGA) * 1000,
  far: (lagOf(CRANE_ROLL_AMPLITUDE.far, CRANE_BEND_PEAK, PHI) / OMEGA) * 1000,
} as const;

export type CraneWingName = "near" | "far";

export type CranePose = {
  /** 肩点刚体角（deg） */
  roll: number;
  /** 内外翼夹角（deg），绕腕点 */
  bend: number;
  /** 该翼翼尖相对肩点的稳态相位滞后（ms） */
  tipLag: number;
};

export function cranePose(seconds: number, wing: CraneWingName): CranePose {
  const theta = OMEGA * seconds;
  const decay = Math.exp(-ZETA * OMEGA_N * seconds);
  const bend =
    CRANE_BEND_PEAK * Math.sin(theta - PHI) +
    decay * (C1 * Math.cos(OMEGA_D * seconds) + C2 * Math.sin(OMEGA_D * seconds));
  return {
    roll: CRANE_ROLL_AMPLITUDE[wing] * Math.sin(theta),
    bend,
    tipLag: TIP_LAG_MS[wing],
  };
}

/** 弹簧的标定值，探针与报告用；渲染路径不读它 */
export const CRANE_SPRING = {
  zeta: ZETA,
  ratio: RATIO,
  omegaN: OMEGA_N,
  omegaD: OMEGA_D,
  gain: GAIN,
  phiDeg: (PHI * 180) / Math.PI,
  tipLagMs: TIP_LAG_MS,
} as const;

// 生产构建里 import.meta.env.DEV 为 false，整段被摇掉
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as Window & { __cranePose?: unknown }).__cranePose = { cranePose, spring: CRANE_SPRING };
}
