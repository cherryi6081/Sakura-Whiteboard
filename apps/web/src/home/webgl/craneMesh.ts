/**
 * 丹顶鹤的 WebGL 几何烘焙（纯函数，不持有任何渲染状态）。
 *
 * 造型语言与 SVG 版严格一致：**平涂色块 + 细墨线**。
 * 所以这里不做贴图、不做渐变、不做光照——只把 craneGeometry.ts 里的路径拆成
 *   1) 填充三角面（earcut，凹多边形安全），逐顶点带「角色色」与 alpha；
 *   2) 描边缎带（中心线 + 逐顶点法线），宽度在顶点着色器里按屏幕像素保底 1px。
 *
 * 坐标系：与 craneGeometry 的 viewBox 0 0 240 130 同源，但**以画面中心 (120,65) 为原点**，
 * 这样外层 group 的旋转天然绕鹤的中心（对应 CSS 的 transform-origin: 50% 50%），
 * 两翼与腿再各自把几何平移到自己枢轴点的局部坐标，直接给 mesh.rotation 用。
 *
 * 分组按「可动性」而不是按图层：图层顺序靠三角形提交顺序保证（材质关闭深度测试），
 * 因此每只鹤只需要 4 次 draw call：legs / farWing / body(含头) / nearWing。
 * 头部的 z 7 虽然高于近翼 z 6，但两者在摆幅内没有任何重叠，合进 body 组不改变观感。
 */
import * as THREE from "three";
import {
  CRANE_BEAK,
  CRANE_BELLY,
  CRANE_BODY,
  CRANE_COVERTS,
  CRANE_CROWN,
  CRANE_EYE,
  CRANE_FAR_LEG,
  CRANE_FAR_PRIMARIES,
  CRANE_FAR_TOES,
  CRANE_FAR_WING,
  CRANE_FAR_WING_SHAFT,
  CRANE_FLANK,
  CRANE_HEAD,
  CRANE_LEG,
  CRANE_NAPE,
  CRANE_NEAR_WING,
  CRANE_NEAR_WING_EDGE,
  CRANE_NECK,
  CRANE_PRIMARIES,
  CRANE_SECONDARIES,
  CRANE_SHOULDER,
  CRANE_TAIL,
  CRANE_TOES,
  CRANE_VIEWBOX,
  bladePath,
} from "../craneGeometry";
import { CRANE_BEND_RIG } from "../cranePose";

/** 顶点色角色。着色器按角色取 uWhite/uShade/... 一个 uniform，换时辰只改 uniform，不重建几何 */
export const CRANE_ROLE = {
  white: 0,
  shade: 1,
  edge: 2,
  ink: 3,
  crown: 4,
  beak: 5,
  leg: 6,
  eye: 7,
  shaft: 8,
  farFace: 9,
  nearFace: 10,
} as const;

export const CRANE_ROLE_COUNT = 11;

/** 鹤的局部高度（viewBox 高）。crane.ts 用它把 CSS 高度换算成局部单位 */
export const CRANE_LOCAL_HEIGHT = CRANE_VIEWBOX.height;

export type Point2 = { x: number; y: number };
export type FlatContour = { points: Point2[]; closed: boolean };

const COMMAND_RE = /[MLCQZ][^MLCQZ]*/gi;
const NUMBER_RE = /-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

/** viewBox 中心即外层 group 的原点 */
const CENTER_X = CRANE_VIEWBOX.width / 2;
const CENTER_Y = CRANE_VIEWBOX.height / 2;

/** 局部枢轴：肩点（两翼共用）、髋点（双腿共用，绕着近腿髋转） */
const SHOULDER = { x: CRANE_SHOULDER.x - CENTER_X, y: CRANE_SHOULDER.y - CENTER_Y };
const HIP = { x: CRANE_LEG[0].x - CENTER_X, y: CRANE_LEG[0].y - CENTER_Y };

/**
 * 把 SVG path 拆成折线轮廓。只支持这套数据用到的 M/L/C/Q/Z，
 * 曲线按控制多边形长度自适应取 6–18 段（局部单位下误差 <0.05，约 0.03px，不可见）。
 */
export function flattenPath(d: string): FlatContour[] {
  const commands = d.match(COMMAND_RE) ?? [];
  const contours: FlatContour[] = [];
  let current: Point2[] | null = null;
  let cx = 0;
  let cy = 0;

  const finish = (closed: boolean) => {
    if (!current) return;
    const points = current;
    if (closed && points.length > 1) {
      const first = points[0];
      const last = points[points.length - 1];
      if (Math.abs(first.x - last.x) < 1e-6 && Math.abs(first.y - last.y) < 1e-6) points.pop();
    }
    if (points.length >= 2) contours.push({ points, closed });
    current = null;
  };

  for (const raw of commands) {
    const cmd = raw[0].toUpperCase();
    const nums = (raw.slice(1).match(NUMBER_RE) ?? []).map(Number);

    if (cmd === "M") {
      if (current) finish(false);
      if (nums.length < 2) continue;
      cx = nums[0];
      cy = nums[1];
      current = [{ x: cx, y: cy }];
      for (let i = 2; i + 1 < nums.length; i += 2) {
        cx = nums[i];
        cy = nums[i + 1];
        current.push({ x: cx, y: cy });
      }
      continue;
    }

    if (!current) continue;

    if (cmd === "L") {
      for (let i = 0; i + 1 < nums.length; i += 2) {
        cx = nums[i];
        cy = nums[i + 1];
        current.push({ x: cx, y: cy });
      }
    } else if (cmd === "C") {
      for (let i = 0; i + 5 < nums.length; i += 6) {
        const p0 = { x: cx, y: cy };
        const p1 = { x: nums[i], y: nums[i + 1] };
        const p2 = { x: nums[i + 2], y: nums[i + 3] };
        const p3 = { x: nums[i + 4], y: nums[i + 5] };
        sampleCubic(p0, p1, p2, p3, current);
        cx = p3.x;
        cy = p3.y;
      }
    } else if (cmd === "Q") {
      for (let i = 0; i + 3 < nums.length; i += 4) {
        const p0 = { x: cx, y: cy };
        const p1 = { x: nums[i], y: nums[i + 1] };
        const p2 = { x: nums[i + 2], y: nums[i + 3] };
        sampleQuadratic(p0, p1, p2, current);
        cx = p2.x;
        cy = p2.y;
      }
    } else if (cmd === "Z") {
      finish(true);
    }
  }

  finish(false);
  return contours;
}

function sampleCubic(p0: Point2, p1: Point2, p2: Point2, p3: Point2, out: Point2[]): void {
  const len =
    Math.hypot(p1.x - p0.x, p1.y - p0.y) +
    Math.hypot(p2.x - p1.x, p2.y - p1.y) +
    Math.hypot(p3.x - p2.x, p3.y - p2.y);
  const steps = Math.min(18, Math.max(6, Math.ceil(len / 2.2)));
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const u = 1 - t;
    out.push({
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
    });
  }
}

function sampleQuadratic(p0: Point2, p1: Point2, p2: Point2, out: Point2[]): void {
  const len = Math.hypot(p1.x - p0.x, p1.y - p0.y) + Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const steps = Math.min(16, Math.max(5, Math.ceil(len / 2.2)));
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const u = 1 - t;
    out.push({
      x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
      y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
    });
  }
}

type Accumulator = {
  pos: number[];
  nrm: number[];
  side: number[];
  role: number[];
  alpha: number[];
  width: number[];
  /** 展向弯曲：x 权重 0..1，yz 腕点（翼局部坐标）。躯干/腿恒为 0，不在着色器里转 */
  bend: number[];
};

function emptyAcc(): Accumulator {
  return { pos: [], nrm: [], side: [], role: [], alpha: [], width: [], bend: [] };
}

function pushVert(
  acc: Accumulator,
  x: number,
  y: number,
  nx: number,
  ny: number,
  side: number,
  role: number,
  alpha: number,
  width: number,
): void {
  acc.pos.push(x, y, 0);
  acc.nrm.push(nx, ny);
  acc.side.push(side);
  acc.role.push(role);
  acc.alpha.push(alpha);
  acc.width.push(width);
  acc.bend.push(0, 0, 0);
}

/**
 * 给一整翼烘焙展向弯曲权重（**不新增顶点/网格**，只多一个 vec3 属性）。
 * 权重 = smoothstep(0.60 → 1.00 翼长)，腕点 = 0.66 翼长处（自肩点量的同一条径向上）。
 * 顶点着色器按权重点 `ang = uBend * weight` 绕腕点转，于是内翼几乎不动、
 * 外翼渐进弯折，翼尖的附加位移恰好是 (1 − 0.66)·翼长·sin(bend)。
 * 返回翼长（局部单位），供探针算位移占比。
 */
function applySpanBend(acc: Accumulator): number {
  let span = 0;
  let tipX = 0;
  let tipY = 0;
  for (let i = 0; i < acc.pos.length; i += 3) {
    const r = Math.hypot(acc.pos[i], acc.pos[i + 1]);
    if (r > span) {
      span = r;
      tipX = acc.pos[i];
      tipY = acc.pos[i + 1];
    }
  }
  if (span <= 0) return 0;

  const wristX = tipX * CRANE_BEND_RIG.wrist;
  const wristY = tipY * CRANE_BEND_RIG.wrist;
  const start = CRANE_BEND_RIG.start;
  const inv = 1 / (1 - start);
  for (let i = 0; i < acc.pos.length; i += 3) {
    const r = Math.hypot(acc.pos[i], acc.pos[i + 1]) / span;
    const t = Math.min(1, Math.max(0, (r - start) * inv));
    acc.bend[i] = t * t * (3 - 2 * t);
    acc.bend[i + 1] = wristX;
    acc.bend[i + 2] = wristY;
  }
  return span;
}

/** 把 viewBox 坐标平移到「以画面中心为原点、再减去分组枢轴」的局部坐标 */
function localize(points: readonly Point2[], pivot: Point2): Point2[] {
  return points.map((p) => ({ x: p.x - CENTER_X - pivot.x, y: p.y - CENTER_Y - pivot.y }));
}

function localizedContour(contour: FlatContour, pivot: Point2): Point2[] {
  return localize(contour.points, pivot);
}

/** 填充面：earcut 三角化，逐三角形 3 个顶点，法线/边号/线宽全部为 0（不参与描边扩边） */
function emitFill(acc: Accumulator, points: Point2[], role: number, alpha: number): void {
  if (points.length < 3) return;
  const shape = points.map((p) => new THREE.Vector2(p.x, p.y));
  const faces = THREE.ShapeUtils.triangulateShape(shape, []);
  for (const face of faces) {
    for (const index of face) {
      const p = points[index];
      pushVert(acc, p.x, p.y, 0, 0, 0, role, alpha, 0);
    }
  }
}

/**
 * 描边：中心线 + 逐顶点「角平分线法线」。真正的线宽在顶点着色器里算：
 *   w = max(aWidth, 1 / uCssPxPerLocal)
 * 于是 0.6px 的墨线永远以 1px、约 0.6 的 alpha 画出来——既不丢样本闪烁，
 * 也保住 SVG 里那种「淡墨」而不是实心黑边。
 */
function emitRibbon(
  acc: Accumulator,
  points: Point2[],
  closed: boolean,
  width: number,
  role: number,
  alpha: number,
): void {
  const pts = points.slice();
  if (closed && pts.length > 1) {
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (Math.abs(first.x - last.x) < 1e-6 && Math.abs(first.y - last.y) < 1e-6) pts.pop();
  }
  const count = pts.length;
  if (count < 2) return;

  const segCount = closed ? count : count - 1;
  const segs: { nx: number; ny: number }[] = [];
  for (let i = 0; i < segCount; i += 1) {
    const a = pts[i];
    const b = pts[(i + 1) % count];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    segs.push({ nx: -dy / len, ny: dx / len });
  }

  const normals: { nx: number; ny: number }[] = [];
  for (let i = 0; i < count; i += 1) {
    const prev = closed ? segs[(i - 1 + segCount) % segCount] : segs[Math.max(0, i - 1)];
    const next = closed ? segs[i % segCount] : segs[Math.min(segCount - 1, i)];
    let nx = prev.nx + next.nx;
    let ny = prev.ny + next.ny;
    const len = Math.hypot(nx, ny) || 1;
    nx /= len;
    ny /= len;
    const dot = nx * next.nx + ny * next.ny;
    const miter = Math.min(2.5, 1 / Math.max(0.4, dot));
    normals.push({ nx: nx * miter, ny: ny * miter });
  }

  const quad = (ia: number, ib: number) => {
    const a = pts[ia];
    const b = pts[ib];
    const na = normals[ia];
    const nb = normals[ib];
    pushVert(acc, a.x, a.y, na.nx, na.ny, 1, role, alpha, width);
    pushVert(acc, a.x, a.y, na.nx, na.ny, -1, role, alpha, width);
    pushVert(acc, b.x, b.y, nb.nx, nb.ny, 1, role, alpha, width);
    pushVert(acc, b.x, b.y, nb.nx, nb.ny, 1, role, alpha, width);
    pushVert(acc, a.x, a.y, na.nx, na.ny, -1, role, alpha, width);
    pushVert(acc, b.x, b.y, nb.nx, nb.ny, -1, role, alpha, width);
  };

  for (let i = 0; i < segCount; i += 1) {
    quad(i, (i + 1) % count);
  }
}

function circlePoints(cx: number, cy: number, r: number, segments: number): Point2[] {
  const out: Point2[] = [];
  for (let i = 0; i < segments; i += 1) {
    const a = (i / segments) * Math.PI * 2;
    out.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  return out;
}

function bladeContour(feather: { base: Point2; tip: Point2; width: number; bow: number }): Point2[] {
  const contours = flattenPath(bladePath(feather.base, feather.tip, feather.width, feather.bow));
  return contours[0] ? contours[0].points : [];
}

function toGeometry(acc: Accumulator): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(acc.pos, 3));
  geometry.setAttribute("aNormal", new THREE.Float32BufferAttribute(acc.nrm, 2));
  geometry.setAttribute("aSide", new THREE.Float32BufferAttribute(acc.side, 1));
  geometry.setAttribute("aRole", new THREE.Float32BufferAttribute(acc.role, 1));
  geometry.setAttribute("aAlpha", new THREE.Float32BufferAttribute(acc.alpha, 1));
  geometry.setAttribute("aWidth", new THREE.Float32BufferAttribute(acc.width, 1));
  geometry.setAttribute("aBend", new THREE.Float32BufferAttribute(acc.bend, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

function triangleCount(acc: Accumulator): number {
  return acc.pos.length / 9;
}

/** 腿：远腿更细更淡（0.72），与 CSS 的 .wb-crane__leg-group--far 一致 */
function buildLegs(): Accumulator {
  const acc = emptyAcc();
  const leg = (points: readonly Point2[], width: number, alpha: number) => {
    emitRibbon(acc, localize(points, HIP), false, width, CRANE_ROLE.leg, alpha);
  };
  leg(CRANE_FAR_LEG, 1.7, 0.72);
  for (const [a, b] of CRANE_FAR_TOES) leg([a, b], 1.7, 0.72);
  leg(CRANE_LEG, 2, 1);
  for (const [a, b] of CRANE_TOES) leg([a, b], 2, 1);
  return acc;
}

/** 远翼：4 根墨色初级飞羽 → 冷灰翼面（描边 0.85）→ 翼轴结构线 */
function buildFarWing(): Accumulator {
  const acc = emptyAcc();
  for (const feather of CRANE_FAR_PRIMARIES) {
    emitFill(acc, localize(bladeContour(feather), SHOULDER), CRANE_ROLE.ink, 1);
  }
  const face = flattenPath(CRANE_FAR_WING)[0];
  if (face) {
    const pts = localizedContour(face, SHOULDER);
    emitFill(acc, pts, CRANE_ROLE.farFace, 1);
    emitRibbon(acc, pts, true, 0.85, CRANE_ROLE.edge, 1);
  }
  const shaft = flattenPath(CRANE_FAR_WING_SHAFT)[0];
  if (shaft) emitRibbon(acc, localizedContour(shaft, SHOULDER), false, 0.9, CRANE_ROLE.shaft, 1);
  return acc;
}

/** 躯干组：尾羽 → 颈（+颈后线）→ 躯干（+体侧/腹影）→ 头喙冠眼，全部按七层顺序提交 */
function buildBody(): Accumulator {
  const acc = emptyAcc();
  const pivot = { x: 0, y: 0 };

  for (const feather of CRANE_TAIL) {
    emitFill(acc, localize(bladeContour(feather), pivot), CRANE_ROLE.ink, 1);
  }

  const neck = flattenPath(CRANE_NECK)[0];
  if (neck) {
    const pts = localizedContour(neck, pivot);
    emitFill(acc, pts, CRANE_ROLE.white, 1);
    emitRibbon(acc, pts, true, 0.95, CRANE_ROLE.edge, 1);
  }
  const nape = flattenPath(CRANE_NAPE)[0];
  if (nape) emitRibbon(acc, localizedContour(nape, pivot), false, 0.9, CRANE_ROLE.shaft, 1);

  const body = flattenPath(CRANE_BODY)[0];
  if (body) {
    const pts = localizedContour(body, pivot);
    emitFill(acc, pts, CRANE_ROLE.white, 1);
    emitRibbon(acc, pts, true, 0.95, CRANE_ROLE.edge, 1);
  }

  const flank = flattenPath(CRANE_FLANK)[0];
  if (flank) emitFill(acc, localizedContour(flank, pivot), CRANE_ROLE.shade, 1);

  const belly = flattenPath(CRANE_BELLY)[0];
  if (belly) emitFill(acc, localizedContour(belly, pivot), CRANE_ROLE.shade, 0.72);

  const head = flattenPath(CRANE_HEAD)[0];
  if (head) {
    const pts = localizedContour(head, pivot);
    emitFill(acc, pts, CRANE_ROLE.white, 1);
    emitRibbon(acc, pts, true, 0.95, CRANE_ROLE.edge, 1);
  }

  const beak = flattenPath(CRANE_BEAK)[0];
  if (beak) emitFill(acc, localizedContour(beak, pivot), CRANE_ROLE.beak, 1);

  const crown = flattenPath(CRANE_CROWN)[0];
  if (crown) emitFill(acc, localizedContour(crown, pivot), CRANE_ROLE.crown, 1);

  emitFill(
    acc,
    localize(circlePoints(CRANE_EYE.x, CRANE_EYE.y, CRANE_EYE.r, 14), pivot),
    CRANE_ROLE.eye,
    1,
  );

  return acc;
}

/** 近翼：3 根次级（填色 + 0.6 羽缘）→ 5 根墨色初级 → 翼面 → 外轮廓 → 两道覆羽线 */
function buildNearWing(): Accumulator {
  const acc = emptyAcc();

  for (const feather of CRANE_SECONDARIES) {
    const pts = localize(bladeContour(feather), SHOULDER);
    emitFill(acc, pts, CRANE_ROLE.nearFace, 1);
    emitRibbon(acc, pts, true, 0.6, CRANE_ROLE.shaft, 0.85);
  }
  for (const feather of CRANE_PRIMARIES) {
    emitFill(acc, localize(bladeContour(feather), SHOULDER), CRANE_ROLE.ink, 1);
  }

  const face = flattenPath(CRANE_NEAR_WING)[0];
  if (face) emitFill(acc, localizedContour(face, SHOULDER), CRANE_ROLE.nearFace, 1);

  const edge = flattenPath(CRANE_NEAR_WING_EDGE)[0];
  if (edge) emitRibbon(acc, localizedContour(edge, SHOULDER), false, 0.9, CRANE_ROLE.edge, 1);

  for (const d of CRANE_COVERTS) {
    const covert = flattenPath(d)[0];
    if (covert) emitRibbon(acc, localizedContour(covert, SHOULDER), false, 0.9, CRANE_ROLE.shaft, 1);
  }

  return acc;
}

export type CraneGroupId = "legs" | "farWing" | "body" | "nearWing";

export type CraneGeometrySet = {
  groups: Record<CraneGroupId, THREE.BufferGeometry>;
  /** 分组枢轴（局部单位），直接给 mesh.position；几何已相对枢轴烘焙 */
  pivots: {
    shoulder: { x: number; y: number };
    hip: { x: number; y: number };
  };
  /** 一个振翅周期里的起伏幅度（局部单位，= viewBox 高 × 0.02，与 CSS 的 -2% 一致） */
  bobOffset: number;
  /** 两翼的翼长（肩点 → 翼尖，局部单位），探针用它算「翼尖位移占翼展」 */
  spans: { near: number; far: number };
  stats: {
    triangles: number;
    vertices: number;
    perGroup: Record<CraneGroupId, number>;
  };
};

export function buildCraneGeometry(): CraneGeometrySet {
  const legs = buildLegs();
  const farWing = buildFarWing();
  const body = buildBody();
  const nearWing = buildNearWing();

  const spans = { near: applySpanBend(nearWing), far: applySpanBend(farWing) };

  const perGroup: Record<CraneGroupId, number> = {
    legs: triangleCount(legs),
    farWing: triangleCount(farWing),
    body: triangleCount(body),
    nearWing: triangleCount(nearWing),
  };

  const triangles = perGroup.legs + perGroup.farWing + perGroup.body + perGroup.nearWing;

  return {
    groups: {
      legs: toGeometry(legs),
      farWing: toGeometry(farWing),
      body: toGeometry(body),
      nearWing: toGeometry(nearWing),
    },
    pivots: {
      shoulder: { ...SHOULDER },
      hip: { ...HIP },
    },
    bobOffset: CRANE_VIEWBOX.height * 0.02,
    spans,
    stats: {
      triangles,
      vertices: triangles * 3,
      perGroup,
    },
  };
}
