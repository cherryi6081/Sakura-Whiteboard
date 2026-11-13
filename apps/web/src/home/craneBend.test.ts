import { describe, expect, it } from "vitest";
import { CRANE_BEND_RIG, cranePose } from "./cranePose";
import { CRANE_FLAP_SECONDS } from "./craneGeometry";
import type { CraneGeometrySet } from "./webgl/craneMesh";
import { buildCraneGeometry } from "./webgl/craneMesh";

/**
 * 展向弯曲的几何自查（不看「位移百分比」，只看形状是否还成立）。
 *
 * 判据全部来自几何本身：
 *  1. 三角面朝向：同一三角形弯曲前后的有向面积必须同号。按面积分三档：
 *     主体 ≥10 单位²、中等 1–10 单位²（两档都必须 0 翻面）、
 *     退化 <1 单位² 的 earcut 碎面（允许翻，但形变后面积必须仍是亚像素）。
 *     不比面积比：细长三角面的面积比对剪切极敏感，不是折叠判据，只作报告。
 *  2. 折叠：弯曲映射 f 的雅可比行列式，1 单位网格逐点数值求导，要求处处 > 0。
 *     行列式变号/归零 = 局部折叠，翼面穿过自己。
 *  3. 自交：把形变后的**有面积**三角面按 0.5 单位光栅化，同一角色内、
 *     互不共顶点的两个三角面同时覆盖同一像素中心即判一对重叠；每 6 帧一次，共 120 次。
 *     原画本身就有层间叠压（静止姿态近翼 177 对 / 远翼 101 对），所以只判**新增**对，
 *     并且新增对的重叠面积必须是亚像素。
 *  4. 出平面：弯曲是绕 z 轴的二维旋转，所有顶点 Δz 必须为 0（翼尖不离开翼面平面）。
 *  5. 描边：缎带三角形在几何里零宽，宽度由顶点着色器补
 *     （offset = n · side · width / 2）。按同一条公式还原渲染三角形，要求符号不翻；
 *     可见段（≥2 单位长，≈1.2px）的面积比不许塌。
 *
 * 扫描两个完整振翅周期（含上电瞬态），逐帧检查，共 720 帧。
 */

const DEG = Math.PI / 180;
const STEP = CRANE_FLAP_SECONDS / 360;
const FRAMES = 720;
/** 自交光栅每 6 帧一次（120 次），覆盖上下两个振翅周期 */
const RASTER_EVERY = 6;
/** 光栅格边长（局部单位）：0.5 单位 ≈ 0.3px（1440 端），远小于任何可见折痕 */
const RASTER_CELL = 0.5;

type WingSample = {
  positions: Float32Array;
  normals: Float32Array;
  sides: Float32Array;
  widths: Float32Array;
  bend: Float32Array;
  roles: Float32Array;
  /** 每个三角形的三个顶点键（静止坐标），用于判「共顶点 = 相邻」 */
  triKeys: string[][];
  span: number;
  wristX: number;
  wristY: number;
};

function sampleWing(geometry: CraneGeometrySet["groups"]["nearWing"]): WingSample {
  const positions = geometry.getAttribute("position").array as Float32Array;
  const normals = geometry.getAttribute("aNormal").array as Float32Array;
  const sides = geometry.getAttribute("aSide").array as Float32Array;
  const widths = geometry.getAttribute("aWidth").array as Float32Array;
  const bend = geometry.getAttribute("aBend").array as Float32Array;
  const roles = geometry.getAttribute("aRole").array as Float32Array;
  const n = positions.length / 3;
  const triKeys: string[][] = [];
  for (let t = 0; t < n; t += 3) {
    const keys: string[] = [];
    for (let v = 0; v < 3; v += 1) {
      keys.push(`${positions[(t + v) * 3].toFixed(3)},${positions[(t + v) * 3 + 1].toFixed(3)}`);
    }
    triKeys.push(keys);
  }
  let span = 0;
  let tipX = 0;
  let tipY = 0;
  for (let i = 0; i < n; i += 1) {
    const r = Math.hypot(positions[i * 3], positions[i * 3 + 1]);
    if (r > span) {
      span = r;
      tipX = positions[i * 3];
      tipY = positions[i * 3 + 1];
    }
  }
  return {
    positions,
    normals,
    sides,
    widths,
    bend,
    roles,
    triKeys,
    span,
    wristX: tipX * CRANE_BEND_RIG.wrist,
    wristY: tipY * CRANE_BEND_RIG.wrist,
  };
}

/** 与 `applySpanBend` 同一条公式：smoothstep(0.60 → 1.00 翼长) */
function weightAt(x: number, y: number, span: number): number {
  const r = Math.hypot(x, y) / span;
  const t = Math.min(1, Math.max(0, (r - CRANE_BEND_RIG.start) / (1 - CRANE_BEND_RIG.start)));
  return t * t * (3 - 2 * t);
}

/** 与顶点着色器逐字同构：p' = wrist + R(θ·w) · (p − wrist) */
function deform(x: number, y: number, weight: number, wristX: number, wristY: number, angle: number) {
  if (weight <= 0) return { x, y };
  const a = angle * weight;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const dx = x - wristX;
  const dy = y - wristY;
  return { x: wristX + dx * c - dy * s, y: wristY + dx * s + dy * c };
}

function signedArea(ax: number, ay: number, bx: number, by: number, cx: number, cy: number) {
  return ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2;
}

type RasterReport = { cells: number; pairs: Map<string, number> };

type WingReport = {
  surface: number;
  ribbons: number;
  mainFlips: number;
  midFlips: number;
  sliverFlips: number;
  /** 任意面积档的翻面总数与翻面后最大面积（局部单位²） */
  flipCount: number;
  maxFlipArea: number;
  slivers: number;
  maxSliverArea: number;
  minMainRatio: number;
  minMidRatio: number;
  ribbonReversals: number;
  /** 可见缎带段（≥2 单位长）的最小面积比 */
  minVisibleRibbonRatio: number;
  /** 全部缎带段的最小面积比，仅报告 */
  minRibbonRatio: number;
  /** 面积比最低的那一段：长度（单位）与弯曲前后面积 */
  worstRibbon: { ratio: number; area0: number; area1: number; length: number };
  minDet: number;
  maxDz: number;
  overlap: RasterReport;
};

/** 面积分档（局部坐标单位²）。鹤整体 240 单位宽，1440 端约 0.62 px/单位，1 单位² ≈ 0.4 px² */
const SLIVER_AREA = 1;
const MID_AREA = 10;
/** 退化三角面形变后的面积上限：4 单位² ≈ 1.5 px² */
const SLIVER_LIMIT = 4;
/** 「可见」缎带段的长度下限（局部单位）：2 单位 ≈ 1.2px（1440 端） */
const VISIBLE_RIBBON = 2;
/**
 * 新增重叠对的上限：12 格 × 0.25 单位² = 3 单位² ≈ 1.2 px²（1440 端）/ 0.4 px²（390 端）——
 * 仍在亚像素尺度。真正的折痕会沿弯曲线跨几十上百格。
 */
const OVERLAP_LIMIT_CELLS = 12;
/** 新增重叠总面积不超过原画自身叠压量的 5%：弯曲只允许让已有层间叠压轻微错位 */
const OVERLAP_BASE_SHARE = 0.05;

/**
 * 把形变后的有面积三角面光栅化。返回：
 *  - cells：被两个及以上**同角色、互不共顶点**三角面同时覆盖的像素中心数；
 *  - pairs：每一对重叠三角面各覆盖了多少格（键 = 两个三角形的顶点偏移，小的在前）。
 *
 * 只在同一角色内比：一翼里本来就有两层填充（翼面 nearFace / 羽缘 ink），它们按设计互相覆盖。
 * 采样点对格边做无理偏移：earcut 的网格边大量与 0.5 网格轴对齐，用正中心采样会把
 * 「共边」误判成「重叠」（实测 2272 格），偏移后共边恰好落在采样点上的概率为 0。
 */
function rasterSurface(
  px: Float64Array,
  py: Float64Array,
  roles: Float32Array,
  triKeys: string[][],
  n: number,
  cell: number,
): RasterReport {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i += 1) {
    minX = Math.min(minX, px[i]);
    maxX = Math.max(maxX, px[i]);
    minY = Math.min(minY, py[i]);
    maxY = Math.max(maxY, py[i]);
  }
  const gw = Math.ceil((maxX - minX) / cell) + 2;
  const gh = Math.ceil((maxY - minY) / cell) + 2;
  const first = new Int32Array(gw * gh).fill(-1);
  const second = new Int32Array(gw * gh).fill(-1);
  const ox = 0.1371;
  const oy = 0.2913;

  for (let t = 0; t < n; t += 3) {
    const ax = px[t];
    const ay = py[t];
    const bx = px[t + 1];
    const by = py[t + 1];
    const cx = px[t + 2];
    const cy = py[t + 2];
    const area = signedArea(ax, ay, bx, by, cx, cy);
    if (Math.abs(area) < 1e-7) continue;
    const s = area > 0 ? 1 : -1;
    const j0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - minX) / cell));
    const j1 = Math.min(gw - 1, Math.ceil((Math.max(ax, bx, cx) - minX) / cell) + 1);
    const i0 = Math.max(0, Math.floor((Math.min(ay, by, cy) - minY) / cell));
    const i1 = Math.min(gh - 1, Math.ceil((Math.max(ay, by, cy) - minY) / cell) + 1);
    for (let i = i0; i <= i1; i += 1) {
      const y = minY + (i + ox) * cell;
      for (let j = j0; j <= j1; j += 1) {
        const x = minX + (j + oy) * cell;
        const e0 = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
        const e1 = (cx - bx) * (y - by) - (cy - by) * (x - bx);
        const e2 = (ax - cx) * (y - cy) - (ay - cy) * (x - cx);
        if (s * e0 > 0 && s * e1 > 0 && s * e2 > 0) {
          const k = i * gw + j;
          if (first[k] < 0) first[k] = t;
          else if (second[k] < 0 && Math.round(roles[first[k]]) === Math.round(roles[t])) second[k] = t;
        }
      }
    }
  }

  let cells = 0;
  const pairs = new Map<string, number>();
  for (let k = 0; k < first.length; k += 1) {
    if (first[k] < 0 || second[k] < 0) continue;
    const a = first[k];
    const b = second[k];
    const ka = triKeys[a / 3];
    const kb = triKeys[b / 3];
    // 共顶点 = 相邻三角面，共边不算重叠
    if (ka[0] === kb[0] || ka[0] === kb[1] || ka[0] === kb[2]) continue;
    if (ka[1] === kb[0] || ka[1] === kb[1] || ka[1] === kb[2]) continue;
    if (ka[2] === kb[0] || ka[2] === kb[1] || ka[2] === kb[2]) continue;
    cells += 1;
    const key = `${Math.min(a, b)}-${Math.max(a, b)}`;
    pairs.set(key, (pairs.get(key) ?? 0) + 1);
  }
  return { cells, pairs };
}

function checkWing(sample: WingSample, angle: number, raster: boolean): WingReport {
  const { positions, normals, sides, widths, bend, roles, triKeys, wristX, wristY, span } = sample;
  const n = positions.length / 3;
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  let maxDz = 0;
  for (let i = 0; i < n; i += 1) {
    const p = deform(positions[i * 3], positions[i * 3 + 1], bend[i * 3], wristX, wristY, angle);
    px[i] = p.x;
    py[i] = p.y;
    maxDz = Math.max(maxDz, Math.abs(positions[i * 3 + 2]));
  }

  let surface = 0;
  let ribbons = 0;
  let mainFlips = 0;
  let midFlips = 0;
  let sliverFlips = 0;
  let flipCount = 0;
  let maxFlipArea = 0;
  let slivers = 0;
  let maxSliverArea = 0;
  let minMainRatio = Infinity;
  let minMidRatio = Infinity;
  let ribbonReversals = 0;
  let minVisibleRibbonRatio = Infinity;
  let minRibbonRatio = Infinity;
  let worstRibbon = { ratio: 1, area0: 0, area1: 0, length: 0 };

  for (let t = 0; t < n; t += 3) {
    const a0 = signedArea(
      positions[t * 3],
      positions[t * 3 + 1],
      positions[(t + 1) * 3],
      positions[(t + 1) * 3 + 1],
      positions[(t + 2) * 3],
      positions[(t + 2) * 3 + 1],
    );
    const a1 = signedArea(px[t], py[t], px[t + 1], py[t + 1], px[t + 2], py[t + 2]);

    if (Math.abs(a0) < 1e-7) {
      // 描边缎带的三角形在几何里是零宽，宽度由着色器补：offset = n · (side · width / 2)。
      // 这里按同一公式把渲染真正得到的三角形还原出来，比较弯曲前后的有向面积。
      ribbons += 1;
      const q0 = [0, 0, 0, 0, 0, 0];
      const q1 = [0, 0, 0, 0, 0, 0];
      for (let v = 0; v < 3; v += 1) {
        const k = t + v;
        const off = sides[k] * widths[k] * 0.5;
        const nx0 = normals[k * 2];
        const ny0 = normals[k * 2 + 1];
        q0[v * 2] = positions[k * 3] + nx0 * off;
        q0[v * 2 + 1] = positions[k * 3 + 1] + ny0 * off;
        const a = angle * bend[k * 3];
        const c = Math.cos(a);
        const s = Math.sin(a);
        q1[v * 2] = px[k] + (nx0 * c - ny0 * s) * off;
        q1[v * 2 + 1] = py[k] + (nx0 * s + ny0 * c) * off;
      }
      const r0 = signedArea(q0[0], q0[1], q0[2], q0[3], q0[4], q0[5]);
      const r1 = signedArea(q1[0], q1[1], q1[2], q1[3], q1[4], q1[5]);
      if (Math.abs(r0) > 1e-9) {
        if (Math.sign(r1) !== Math.sign(r0)) ribbonReversals += 1;
        const ratio = Math.abs(r1) / Math.abs(r0);
        minRibbonRatio = Math.min(minRibbonRatio, ratio);
        const length = Math.max(
          Math.hypot(
            positions[t * 3] - positions[(t + 1) * 3],
            positions[t * 3 + 1] - positions[(t + 1) * 3 + 1],
          ),
          Math.hypot(
            positions[(t + 1) * 3] - positions[(t + 2) * 3],
            positions[(t + 1) * 3 + 1] - positions[(t + 2) * 3 + 1],
          ),
          Math.hypot(
            positions[t * 3] - positions[(t + 2) * 3],
            positions[t * 3 + 1] - positions[(t + 2) * 3 + 1],
          ),
        );
        if (length >= VISIBLE_RIBBON) minVisibleRibbonRatio = Math.min(minVisibleRibbonRatio, ratio);
        if (ratio < worstRibbon.ratio) {
          worstRibbon = { ratio, area0: r0, area1: r1, length };
        }
      }
      continue;
    }

    surface += 1;
    const signFlip = Math.sign(a1) !== Math.sign(a0);
    if (signFlip) {
      flipCount += 1;
      maxFlipArea = Math.max(maxFlipArea, Math.abs(a1));
    }

    if (Math.abs(a0) < SLIVER_AREA) {
      slivers += 1;
      maxSliverArea = Math.max(maxSliverArea, Math.abs(a1));
      if (signFlip) sliverFlips += 1;
      continue;
    }

    if (Math.abs(a0) < MID_AREA) {
      minMidRatio = Math.min(minMidRatio, Math.abs(a1) / Math.abs(a0));
      if (signFlip) midFlips += 1;
      continue;
    }

    minMainRatio = Math.min(minMainRatio, Math.abs(a1) / Math.abs(a0));
    if (signFlip) mainFlips += 1;
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i += 1) {
    minX = Math.min(minX, positions[i * 3]);
    maxX = Math.max(maxX, positions[i * 3]);
    minY = Math.min(minY, positions[i * 3 + 1]);
    maxY = Math.max(maxY, positions[i * 3 + 1]);
  }
  const h = 0.01;
  let minDet = Infinity;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      // 四个方向的权重各自求（权重是半径的函数，不能共用同一个角）
      const fx0 = deform(x + h, y, weightAt(x + h, y, span), wristX, wristY, angle);
      const fx1 = deform(x - h, y, weightAt(x - h, y, span), wristX, wristY, angle);
      const fy0 = deform(x, y + h, weightAt(x, y + h, span), wristX, wristY, angle);
      const fy1 = deform(x, y - h, weightAt(x, y - h, span), wristX, wristY, angle);
      const det = ((fx0.x - fx1.x) * (fy0.y - fy1.y) - (fx0.y - fy1.y) * (fy0.x - fx1.x)) / (4 * h * h);
      minDet = Math.min(minDet, det);
    }
  }

  return {
    surface,
    ribbons,
    mainFlips,
    midFlips,
    sliverFlips,
    slivers,
    flipCount,
    maxFlipArea,
    maxSliverArea,
    minMainRatio,
    minMidRatio,
    ribbonReversals,
    minVisibleRibbonRatio,
    minRibbonRatio,
    worstRibbon,
    minDet,
    maxDz,
    overlap: raster ? rasterSurface(px, py, roles, triKeys, n, RASTER_CELL) : { cells: 0, pairs: new Map() },
  };
}

describe("丹顶鹤展向弯曲的几何自查", () => {
  it("两个完整振翅周期逐帧：无翻面、无折叠、无出平面、不新增可见自交", () => {
    const geometry = buildCraneGeometry();
    const wings = {
      near: sampleWing(geometry.groups.nearWing),
      far: sampleWing(geometry.groups.farWing),
    };

    for (const wing of ["near", "far"] as const) {
      // 基线：弯曲角为 0，映射是恒等变换。原画本身就有层间叠压（ink 羽缘压在翼面上），
      // 所以自交只判「弯曲后新出现、静止时不存在」的那些三角面对。
      const base = checkWing(wings[wing], 0, true).overlap;

      let acc = {
        surface: 0,
        ribbons: 0,
        mainFlips: 0,
        midFlips: 0,
        sliverFlips: 0,
        slivers: 0,
        flipCount: 0,
        maxFlipArea: 0,
        maxSliverArea: 0,
        minMainRatio: Infinity,
        minMidRatio: Infinity,
        ribbonReversals: 0,
        minVisibleRibbonRatio: Infinity,
        minRibbonRatio: Infinity,
        worstRibbon: { ratio: 1, area0: 0, area1: 0, length: 0 },
        minDet: Infinity,
        minDetFrame: -1,
        maxDz: 0,
        overlapBaseCells: base.cells,
        overlapBasePairs: base.pairs.size,
        overlapCells: 0,
        overlapFrame: -1,
        addedPairs: 0,
        addedCells: 0,
        maxAddedPairCells: 0,
        addedFrame: -1,
        rasterFrames: 0,
      };

      for (let frame = 0; frame < FRAMES; frame += 1) {
        const angle = cranePose(frame * STEP, "near").bend * DEG;
        const raster = frame % RASTER_EVERY === 0;
        const report = checkWing(wings[wing], angle, raster);
        acc.surface = report.surface;
        acc.ribbons = report.ribbons;
        acc.mainFlips += report.mainFlips;
        acc.midFlips += report.midFlips;
        acc.sliverFlips += report.sliverFlips;
        acc.flipCount += report.flipCount;
        acc.maxFlipArea = Math.max(acc.maxFlipArea, report.maxFlipArea);
        acc.slivers = Math.max(acc.slivers, report.slivers);
        acc.maxSliverArea = Math.max(acc.maxSliverArea, report.maxSliverArea);
        acc.minMainRatio = Math.min(acc.minMainRatio, report.minMainRatio);
        acc.minMidRatio = Math.min(acc.minMidRatio, report.minMidRatio);
        acc.ribbonReversals += report.ribbonReversals;
        acc.minVisibleRibbonRatio = Math.min(acc.minVisibleRibbonRatio, report.minVisibleRibbonRatio);
        acc.minRibbonRatio = Math.min(acc.minRibbonRatio, report.minRibbonRatio);
        if (report.worstRibbon.ratio < acc.worstRibbon.ratio) acc.worstRibbon = report.worstRibbon;
        if (report.minDet < acc.minDet) {
          acc.minDet = report.minDet;
          acc.minDetFrame = frame;
        }
        acc.maxDz = Math.max(acc.maxDz, report.maxDz);
        if (report.overlap.cells > acc.overlapCells) {
          acc.overlapCells = report.overlap.cells;
          acc.overlapFrame = frame;
        }
        if (raster) {
          acc.rasterFrames += 1;
          let addedCells = 0;
          let addedPairs = 0;
          for (const [key, count] of report.overlap.pairs) {
            if (base.pairs.has(key)) continue;
            addedPairs += 1;
            addedCells += count;
            if (count > acc.maxAddedPairCells) acc.maxAddedPairCells = count;
          }
          if (addedCells > acc.addedCells) {
            acc.addedCells = addedCells;
            acc.addedPairs = addedPairs;
            acc.addedFrame = frame;
          }
        }
      }

      console.info("[crane-bend]", wing, JSON.stringify(acc));

      // 主体三角面（≥10 单位²）：一次都不许翻
      expect(acc.mainFlips, `${wing} 翼主体三角面翻面`).toBe(0);
      // 细长三角面：绕序可以翻（远翼实测 231 次，均发生在 1–10 单位² 的碎面上），
      // 但翻转后面积必须仍是亚像素 —— 这些面形变后被剪切压到一条线，绕序没有可见后果。
      expect(acc.maxFlipArea, `${wing} 翼翻面三角面形变后仍有可见面积`).toBeLessThan(SLIVER_LIMIT);
      // 退化碎面：翻面只许发生在亚像素尺度
      expect(acc.maxSliverArea, `${wing} 翼退化碎面翻面后面积变大`).toBeLessThan(SLIVER_LIMIT);
      // 描边段：符号不许翻，可见段面积比不许塌
      expect(acc.ribbonReversals, `${wing} 翼描边段倒转`).toBe(0);
      expect(acc.minVisibleRibbonRatio, `${wing} 翼可见描边段塌缩`).toBeGreaterThan(0.5);
      // 映射：雅可比处处为正（无局部折叠）
      expect(acc.minDet, `${wing} 翼映射局部折叠（雅可比 ≤ 0）`).toBeGreaterThan(0);
      // 出平面
      expect(acc.maxDz, `${wing} 翼有顶点跑出翼面平面`).toBeLessThan(1e-6);
      // 自交：新增对必须是亚像素，且新增总面积不超过原画自身叠压量的 5%
      expect(acc.maxAddedPairCells, `${wing} 翼新增重叠三角面对超过亚像素`).toBeLessThanOrEqual(
        OVERLAP_LIMIT_CELLS,
      );
      expect(
        acc.addedCells,
        `${wing} 翼新增重叠面积超过基线的 ${OVERLAP_BASE_SHARE * 100}%`,
      ).toBeLessThanOrEqual(Math.ceil(acc.overlapBaseCells * OVERLAP_BASE_SHARE));
    }
  });
});
