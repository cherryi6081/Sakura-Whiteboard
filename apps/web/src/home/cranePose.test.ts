import { describe, expect, it } from "vitest";
import { CRANE_FLAP_SECONDS } from "./craneGeometry";
import {
  CRANE_BEND_PEAK,
  CRANE_ROLL_AMPLITUDE,
  CRANE_SPRING,
  CRANE_TIP_LAG_TARGET_MS,
  cranePose,
  type CraneWingName,
} from "./cranePose";

/**
 * 姿态函数的验收项，全部按「采样 → 测量」而不是按公式抄一遍：
 * 相位差用过零点、夹角峰值取实测最大、残余振幅取瞬态包络。
 * 浏览器里的探针（.spike/probe-crane-spring.mjs）对这些数字做同一套测量。
 */
const STEP = 0.0001;

/** 稳态窗口：5 个周期之后瞬态已经衰减到不可测 */
const FROM = CRANE_FLAP_SECONDS * 6;
const TO = CRANE_FLAP_SECONDS * 12;

function upwardCrossings(fn: (t: number) => number): number[] {
  const out: number[] = [];
  let prev = fn(FROM);
  for (let t = FROM + STEP; t <= TO; t += STEP) {
    const value = fn(t);
    if (prev <= 0 && value > 0) {
      out.push(t - STEP + (STEP * -prev) / (value - prev));
    }
    prev = value;
  }
  return out;
}

/** 翼尖（roll + bend）相对肩点（roll）的过零点滞后，按最近一次上升过零配对取均值 */
function tipLagMs(wing: CraneWingName): number {
  const roll = upwardCrossings((t) => cranePose(t, wing).roll);
  const tip = upwardCrossings((t) => {
    const pose = cranePose(t, wing);
    return pose.roll + pose.bend;
  });
  const deltas: number[] = [];
  for (const at of roll) {
    const next = tip.find((value) => value > at && value - at < CRANE_FLAP_SECONDS * 0.5);
    if (next !== undefined) deltas.push(next - at);
  }
  expect(deltas.length).toBeGreaterThan(4);
  return (deltas.reduce((sum, value) => sum + value, 0) / deltas.length) * 1000;
}

function bendPeak(wing: CraneWingName): number {
  let peak = 0;
  for (let t = FROM; t <= TO; t += STEP) {
    peak = Math.max(peak, Math.abs(cranePose(t, wing).bend));
  }
  return peak;
}

/** 五周期后的残余振幅：实测 bend 与同相稳态正弦的差，归一化到峰值 */
function residualAfterFiveCycles(): number {
  const steady = (t: number) =>
    CRANE_BEND_PEAK * Math.sin((2 * Math.PI * t) / CRANE_FLAP_SECONDS - (CRANE_SPRING.phiDeg * Math.PI) / 180);
  let worst = 0;
  const start = CRANE_FLAP_SECONDS * 5;
  const end = CRANE_FLAP_SECONDS * 6;
  for (let t = start; t <= end; t += STEP) {
    worst = Math.max(worst, Math.abs(cranePose(t, "near").bend - steady(t)));
  }
  return worst / CRANE_BEND_PEAK;
}

describe("丹顶鹤振翅姿态（cranePose）", () => {
  it("输出只有 roll / bend / tipLag 三个标量", () => {
    const pose = cranePose(1.234, "near");
    expect(Object.keys(pose).sort()).toEqual(["bend", "roll", "tipLag"]);
    expect(Number.isFinite(pose.roll)).toBe(true);
    expect(Number.isFinite(pose.bend)).toBe(true);
  });

  it("肩点角是零均值的 0.9s 正弦，幅值就等于设定值", () => {
    for (const wing of ["near", "far"] as const) {
      let min = Infinity;
      let max = -Infinity;
      for (let t = FROM; t <= TO; t += STEP) {
        const { roll } = cranePose(t, wing);
        min = Math.min(min, roll);
        max = Math.max(max, roll);
      }
      expect(max - min).toBeCloseTo(CRANE_ROLL_AMPLITUDE[wing] * 2, 3);
      expect(Math.abs(max + min)).toBeLessThan(1e-6);
    }
  });

  it("翼尖相对肩点的过零点滞后落在 70±15ms", () => {
    for (const wing of ["near", "far"] as const) {
      const lag = tipLagMs(wing);
      expect(lag).toBeGreaterThanOrEqual(CRANE_TIP_LAG_TARGET_MS - 15);
      expect(lag).toBeLessThanOrEqual(CRANE_TIP_LAG_TARGET_MS + 15);
    }
    // 近翼是标定基准：反解出来的弹簧应当正好落在 70ms
    expect(tipLagMs("near")).toBeCloseTo(CRANE_TIP_LAG_TARGET_MS, 0);
  });

  it("内外翼夹角峰值落在 8–12°", () => {
    for (const wing of ["near", "far"] as const) {
      const peak = bendPeak(wing);
      expect(peak).toBeGreaterThanOrEqual(8);
      expect(peak).toBeLessThanOrEqual(12);
    }
  });

  it("阻尼比给出的回弹超调 ≤ 15%", () => {
    const zeta = CRANE_SPRING.zeta;
    const overshoot = Math.exp((-Math.PI * zeta) / Math.sqrt(1 - zeta * zeta));
    expect(overshoot).toBeLessThanOrEqual(0.15);
  });

  it("五个周期后的残余振幅 ≤ 5%", () => {
    expect(residualAfterFiveCycles()).toBeLessThanOrEqual(0.05);
  });

  it("上电时翼面从 0 起步，没有阶跃", () => {
    expect(Math.abs(cranePose(0, "near").bend)).toBeLessThan(1e-9);
    expect(Math.abs(cranePose(0, "near").roll)).toBeLessThan(1e-9);
  });
});
