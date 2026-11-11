/**
 * 水面波浪采样：与 webgl/water.ts 着色器里 `wave * 0.72 + fine * 0.28` 那一组
 * 频率、相位完全同一套参数，只是搬成可在 JS 里逐点调用的标量函数。
 *
 * 放在 three 之外：移动端 SVG 分支也要用它驱动小舟，不能因为共享一个函数
 * 就把 three 拉进移动端包里。
 *
 * 返回值在 −1..1，是「归一化高度」，不是舞台单位。
 */
export const WAVE_WATERLINE = 566;
const STAGE_BOTTOM = 900;

export function sampleWave(stageX: number, stageY: number, time: number): number {
  const d = Math.min(1, Math.max(0, (stageY - WAVE_WATERLINE) / (STAGE_BOTTOM - WAVE_WATERLINE)));
  // 与着色器同一条频率曲线：远处密（0.42）、近处疏（0.19）
  const freq = 0.42 + (0.19 - 0.42) * Math.pow(d, 0.7);
  const drift = 0.5 + 0.5 * Math.sin(stageX * 0.006 + stageY * 0.05 + time * 0.07);
  const wave = Math.sin(stageY * freq + time * (0.5 + d * 0.3) + drift * 6 + stageX * 0.0007);
  const fine = Math.sin(stageY * freq * 2.7 - time * 0.85 + stageX * 0.0016);
  return wave * 0.72 + fine * 0.28;
}

/** 小舟的锚点（舞台坐标），与 SVG 版 `translate(1272 706)` 一致 */
export const BOAT_ANCHOR = { x: 1272, y: 706 };

export type BoatPose = {
  /** 吃水线相对锚点的上下起伏（舞台单位） */
  dy: number;
  /** 俯仰：船头抬起为正（弧度） */
  pitch: number;
  /** 横摇：靠镜头一侧抬起为正（弧度） */
  roll: number;
  /** 横向漂移（舞台单位），±12 / 40s */
  drift: number;
};

const MAX_PITCH = (3.5 * Math.PI) / 180;
const MAX_ROLL = (2.5 * Math.PI) / 180;

/**
 * 四个采样点：
 * - 船头 / 船尾（x ± 30），高度差 → 俯仰；
 * - 近舷 / 远舷（y ± 8），高度差 → 横摇。侧视图里左右舷落在同一屏幕 x 上，
 *   用「靠近镜头的一侧 / 远离镜头的一侧」做远近采样，才是这条侧视船能表现出的横摇。
 */
export function sampleBoat(time: number): BoatPose {
  const { x, y } = BOAT_ANCHOR;
  const bow = sampleWave(x + 30, y, time);
  const stern = sampleWave(x - 30, y, time);
  const near = sampleWave(x, y + 8, time);
  const far = sampleWave(x, y - 8, time);

  const clamp = (v: number, max: number) => Math.max(-max, Math.min(max, v));

  return {
    dy: ((bow + stern) / 2) * 0.9,
    pitch: clamp((bow - stern) * 0.03, MAX_PITCH),
    roll: clamp((near - far) * 0.022, MAX_ROLL),
    drift: Math.sin((time * Math.PI * 2) / 40) * 12,
  };
}
