/**
 * 湖面波场：TS（小舟姿态）与 GLSL（水面着色）**唯一的一份真值**。
 *
 * 为什么要有这个文件：船的升沉/俯仰要跟水面同一条浪，以前船是 CSS 关键帧、
 * 水面是片元着色器里的正弦，两者各算各的，永远对不上。这里把波形写成一个
 * 纯数据表（方向 / 波数 / 振幅 / 角频率 / 初相），
 *   - TS 侧 sampleWave() 直接按表求和，斜率是解析导数（不做数值差分）；
 *   - GLSL 侧 waveFieldGlsl 也是**从同一张表生成的字符串**（下面的三元组只写一次），
 *     不是手抄一份公式。
 * 因此两边不会有“改了一边忘了另一边”的漂移。
 *
 * 同构性：波形只有正弦叠加，没有噪声。着色器里那点 noise 只负责水纹条纹的漂移
 * （纯装饰，见 water.ts），不参与波高，也不进 sampleWave —— 需要移植噪声才能对齐的
 * 情况在这里不存在。剩下的差异只有 float32（GLSL）与 float64（TS）的舍入，
 * 相对误差 ~1e-7，对应船身尺寸是小到不可见的量。
 *
 * 坐标系：舞台坐标（viewBox 0 0 1600 900），x 向右、**y 向下为正**，单位 = 舞台单位。
 * 波高同样取“向下为正”，所以船体层可以直接 transform: translateY(波高)。
 */
export type WaveComponent = {
  /** 传播方向（已归一化） */
  dirX: number;
  dirY: number;
  /** 波数，rad / 舞台单位 */
  k: number;
  /** 振幅，舞台单位（竖直方向） */
  amp: number;
  /** 角频率，rad / s */
  omega: number;
  /** 初相，rad */
  phase: number;
};

/**
 * [dirX, dirY, k, amp, omega, phase]
 *
 * 三个分量的周期分别取 17.9s / 11.7s / 33.1s —— 沿用旧 heave / swell 的非整数周期，
 * 继续避开花瓣（14–29s 整数）与鹤（25s）的点；波长 419 / 242 / 698 舞台单位，
 * 船身约 154 舞台单位长，刚好跨过不到一个主浪波长，俯仰由斜率主导、三段相位差是二阶量。
 * 合成功率：升沉 ±3.9 舞台单位（≈旧 heave + swell 的 ±5.8 略收），
 * 俯仰峰值 atan(0.057) ≈ 3.3°、均方根 ≈ 1.5°（旧版固定 ±2°）。
 */
const SPECS: ReadonlyArray<readonly [number, number, number, number, number, number]> = [
  [0.9929, 0.1191, 0.015, 2.2, 0.351, 0.0],
  [0.96, -0.28, 0.026, 0.65, 0.537, 1.7],
  [0.848, 0.53, 0.009, 1.05, 0.19, 4.2],
];

export const WAVE_COMPONENTS: readonly WaveComponent[] = SPECS.map(
  ([dirX, dirY, k, amp, omega, phase]) => {
    const norm = Math.hypot(dirX, dirY) || 1;
    return { dirX: dirX / norm, dirY: dirY / norm, k, amp, omega, phase };
  },
);

export type WaveSample = {
  /** 波高（舞台单位，向下为正） */
  height: number;
  /** ∂h/∂x：沿 +x 的斜率 */
  slopeX: number;
  /** ∂h/∂y：沿 +y（向下）的斜率 */
  slopeY: number;
};

/** 采样波面：返回波高与两个方向的解析斜率 */
export function sampleWave(x: number, y: number, t: number): WaveSample {
  let height = 0;
  let slopeX = 0;
  let slopeY = 0;
  for (const w of WAVE_COMPONENTS) {
    const angle = (w.dirX * x + w.dirY * y) * w.k + t * w.omega + w.phase;
    const sin = Math.sin(angle);
    const cos = Math.cos(angle);
    height += w.amp * sin;
    slopeX += w.amp * w.k * w.dirX * cos;
    slopeY += w.amp * w.k * w.dirY * cos;
  }
  return { height, slopeX, slopeY };
}

/** 十进制字面量：GLSL 必须带小数点，且保留 float64 的有效位 */
function f(value: number): string {
  const text = value.toFixed(6).replace(/0+$/, "");
  return text.endsWith(".") ? `${text}0` : text;
}

/**
 * 与 sampleWave 逐项对应的 GLSL 波高函数（斜率只有 TS 侧要用，片元着色器不需要，
 * 所以这里不生成 cos，省掉每像素 3 次三角）。
 * 系数全部从 WAVE_COMPONENTS 插值，表达式顺序与 TS 一致。
 */
export const waveHeightGlsl = /* glsl */ `
  // 由 waveField.ts 的 WAVE_COMPONENTS 生成，勿手改（TS 与 GLSL 共用同一张表）
  float waveHeight(vec2 p, float t) {
    float h = 0.0;
    float ang = 0.0;
${WAVE_COMPONENTS.map(
  (w) => `    ang = dot(vec2(${f(w.dirX)}, ${f(w.dirY)}), p) * ${f(w.k)} + t * ${f(w.omega)} + ${f(w.phase)};
    h += ${f(w.amp)} * sin(ang);`,
).join("\n")}
    return h;
  }
`;

/**
 * 波场时钟：小舟（SVG rAF）与水面（WebGL uniform）读同一个 epoch，
 * 两边每一帧的相位严格是同一个 t。后台标签页回来会跳相位，但两边一起跳。
 */
const EPOCH = typeof performance === "undefined" ? 0 : performance.now();

export function waveTime(): number {
  return (performance.now() - EPOCH) / 1000;
}

// 验收探针要拿同一份 sampleWave 去和 DOM 里量到的俯仰做相关，开发环境挂一个只读入口。
// 生产构建里 import.meta.env.DEV 为 false，整段被摇掉。
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as Window & { __waveField?: unknown }).__waveField = {
    sampleWave,
    waveTime,
    WAVE_COMPONENTS,
  };
}
