/**
 * 左右两棵樱花枝的枝段数据与拓扑自查。
 *
 * 为什么单独抽出来：枝条是"一棵树"，不是一堆互不相干的描边。每段枝都有父枝、
 * 附着比例、相对父枝的夹角与直径，渲染时按"子先父后"的顺序绘制，靠父枝描边
 * 盖住子枝起点，接头处不会露缝。数据放在这里，`fujiBranches.test.ts` 可以逐段校验：
 * 父枝存在、起点落在父枝轮廓内、直径递减、夹角合理、花只挂在末梢。
 *
 * 坐标系：局部 520 × 900，x 向右、y 向下；两棵树各自放到页面的右上 / 左下角，
 * 由 CSS 的 preserveAspectRatio 决定对齐方式，数据本身只管形状关系。
 */

export type Vec = readonly [number, number];

export type SegmentKind = "trunk" | "continue" | "branch" | "twig";

export type BranchSegment = {
  id: string;
  parent: string | null;
  kind: SegmentKind;
  /** 折线（直线段拼接、拐点是硬转折），第一个点落在父枝描边内部 */
  points: ReadonlyArray<Vec>;
  /** 该段恒定描边宽度；同一根枝沿根到梢单调递减 */
  width: number;
};

export type BlossomKind = "bud" | "half" | "full";

export type Blossom = {
  x: number;
  y: number;
  size: number;
  rot: number;
  kind: BlossomKind;
  /** 依附的末梢枝段与附着比例，便于自查"花心贴枝" */
  segmentId: string;
  t: number;
};

/** 一段枝的规格：主枝给点列，其它枝给"挂在谁身上、什么角度、多长、分几折" */
type LimbSpec = {
  id: string;
  /** 父枝 id；null 表示主枝（自画面外伸入） */
  parent: string | null;
  kind: SegmentKind;
  /** 主枝：显式点列；其余枝由父枝上的附着点 + 角度 + 长度生成 */
  points?: ReadonlyArray<Vec>;
  /** 附着在父枝的弧长比例（0–1） */
  t?: number;
  /** 相对父枝局部方向的有符号夹角（度） */
  angle?: number;
  /** 折线段数与总长 */
  pieces?: number;
  length?: number;
  /** 每折相对上一折的偏转（度），制造折线的硬转折 */
  bend?: number;
  /** 各折的描边宽（从根到梢单调递减） */
  widths: number[];
};

const rad = (deg: number) => (deg * Math.PI) / 180;

const len = (v: Vec) => Math.hypot(v[0], v[1]);
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1]];
const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1]];
const scale = (v: Vec, k: number): Vec => [v[0] * k, v[1] * k];
const norm = (v: Vec): Vec => {
  const l = len(v) || 1;
  return [v[0] / l, v[1] / l];
};
/** 屏幕坐标（y 向下）里顺时针为正 */
const rotate = (v: Vec, deg: number): Vec => {
  const c = Math.cos(rad(deg));
  const s = Math.sin(rad(deg));
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c];
};

export function polylineLength(points: ReadonlyArray<Vec>): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += len(sub(points[i], points[i - 1]));
  return total;
}

/** 按弧长比例取点，返回坐标与所处的折线段序号 */
export function pointAlong(points: ReadonlyArray<Vec>, t: number) {
  const total = polylineLength(points);
  let want = Math.min(1, Math.max(0, t)) * total;
  for (let i = 1; i < points.length; i++) {
    const seg = len(sub(points[i], points[i - 1]));
    if (want <= seg || i === points.length - 1) {
      const k = seg === 0 ? 0 : want / seg;
      return { point: add(points[i - 1], scale(sub(points[i], points[i - 1]), k)) as Vec, index: i - 1, t: k };
    }
    want -= seg;
  }
  return { point: points[points.length - 1], index: points.length - 2, t: 1 };
}

/** 某点所在折线段的方向（单位向量） */
export function dirAt(points: ReadonlyArray<Vec>, t: number): Vec {
  const { index } = pointAlong(points, t);
  return norm(sub(points[index + 1], points[index]));
}

/** 点到折线的最短距离（用于校验"起点落在父枝轮廓内"） */
export function distanceToPolyline(points: ReadonlyArray<Vec>, p: Vec): number {
  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const ab = sub(points[i], a);
    const l2 = ab[0] * ab[0] + ab[1] * ab[1] || 1;
    const ap = sub(p, a);
    const k = Math.min(1, Math.max(0, (ap[0] * ab[0] + ap[1] * ab[1]) / l2));
    const q = add(a, scale(ab, k));
    best = Math.min(best, len(sub(p, q)));
  }
  return best;
}

/** 返回点 p 在折线上的弧长比例 */
function nearestT(points: ReadonlyArray<Vec>, p: Vec): number {
  const total = polylineLength(points) || 1;
  let acc = 0;
  let best = { t: 0, d: Infinity };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const ab = sub(points[i], a);
    const l2 = ab[0] * ab[0] + ab[1] * ab[1] || 1;
    const ap = sub(p, a);
    const k = Math.min(1, Math.max(0, (ap[0] * ab[0] + ap[1] * ab[1]) / l2));
    const q = add(a, scale(ab, k));
    const d = len(sub(p, q));
    if (d < best.d) best = { t: (acc + Math.sqrt(l2) * k) / total, d };
    acc += Math.sqrt(l2);
  }
  return best.t;
}

/** 两条方向线的锐夹角（度），用于校验子枝与父枝的分叉角 */
export function acuteAngle(a: Vec, b: Vec): number {
  const c = Math.abs(norm(a)[0] * norm(b)[0] + norm(a)[1] * norm(b)[1]);
  return (Math.acos(Math.min(1, c)) * 180) / Math.PI;
}

/** 折线 → SVG path 的 d 属性（只用 M / L，保持硬转折） */
export function toPathData(points: ReadonlyArray<Vec>): string {
  return points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${+x.toFixed(2)} ${+y.toFixed(2)}`).join(" ");
}

/**
 * 主枝折线 + 逐段宽度 → 首尾相接的段链。
 * 除第一段外，每段起点沿父段回退 `overlap`（不超过父段长度的 30%），
 * 让后画（更粗）的父段盖住接缝；回退点仍在父段中心线上，拓扑连续。
 */
function chainTrunk(id: string, points: ReadonlyArray<Vec>, widths: number[], overlap = 10): BranchSegment[] {
  return widths.map((width, i) => {
    const head = points[i];
    const tail = points[i + 1];
    const back =
      i === 0
        ? head
        : add(head, scale(norm(sub(points[i - 1], head)), Math.min(overlap, len(sub(points[i - 1], head)) * 0.3)));
    return {
      id: `${id}-${i + 1}`,
      parent: i === 0 ? null : `${id}-${i}`,
      kind: i === 0 ? "trunk" : "continue",
      points: [back, tail] as Vec[],
      width,
    };
  });
}

/**
 * 把一段枝按 pieces 折展开：
 * - 第一折方向 = 父枝局部方向旋转 `angle`，之后每折再转 `bend`（逐折递减的硬转折）；
 * - 起点取父枝中心线上的附着点（因此必然落在父枝轮廓内）；
 * - 第二折起，起点沿上一折反向回退一小段，被父段描边覆盖，接缝不露；
 * - 宽度逐折递减，保证子枝不粗于父枝。
 */
function forkSegments(spec: LimbSpec, byId: Map<string, BranchSegment>): BranchSegment[] {
  const parent = spec.parent ? byId.get(spec.parent) : undefined;
  if (!parent) throw new Error(`枝 ${spec.id} 的父枝 ${spec.parent} 不存在`);
  const t = spec.t ?? 0.5;
  const { point, index } = pointAlong(parent.points, t);
  const parentDir = norm(sub(parent.points[index + 1], parent.points[index]));
  const pieces = spec.pieces ?? 1;
  const step = (spec.length ?? 60) / pieces;
  const bend = spec.bend ?? 0;
  const baseAngle = spec.angle ?? 42;

  const out: BranchSegment[] = [];
  let prevEnd: Vec = point;
  let prevDir: Vec = parentDir;
  let prevWidth = parent.width;

  for (let i = 0; i < pieces; i++) {
    const dir = rotate(prevDir, i === 0 ? baseAngle : bend);
    // 回退量取"父段半宽 / 父段长度"的较小值：既保证起点落在父段描边内，
    // 又让附着比例明显小于 1（不是端点相切）
    const back = i === 0 ? prevEnd : add(prevEnd, scale(dir, -Math.max(1.5, Math.min(8, prevWidth * 0.6, step * 0.2))));
    const next = add(prevEnd, scale(dir, step));
    out.push({
      id: i === 0 ? spec.id : `${spec.id}-${i + 1}`,
      parent: i === 0 ? parent.id : out[i - 1].id,
      kind: i === 0 ? spec.kind : "continue",
      points: [back, next] as Vec[],
      width: spec.widths[Math.min(i, spec.widths.length - 1)],
    });
    prevEnd = next;
    prevDir = dir;
    prevWidth = spec.widths[Math.min(i, spec.widths.length - 1)];
  }
  return out;
}

type TreeSpec = { limbs: LimbSpec[] };

function buildTree(spec: TreeSpec): { segments: BranchSegment[]; byId: Map<string, BranchSegment> } {
  const segments: BranchSegment[] = [];
  const byId = new Map<string, BranchSegment>();
  for (const limb of spec.limbs) {
    const made = limb.points ? chainTrunk(limb.id, limb.points, limb.widths) : forkSegments(limb, byId);
    for (const seg of made) {
      if (byId.has(seg.id)) throw new Error(`枝段 id 重复：${seg.id}`);
      segments.push(seg);
      byId.set(seg.id, seg);
    }
  }
  return { segments, byId };
}

// ---------------------------------------------------------------------------
// 右侧：主枝自右缘偏上伸入，一路向右下垂落（下垂枝）。
// 侧枝在主干周围交错分开、向外下方舒展，末梢再挂短梢。
// ---------------------------------------------------------------------------
const RIGHT_SPEC: TreeSpec = {
  limbs: [
    {
      id: "r-trunk",
      parent: null,
      kind: "trunk",
      widths: [13, 11.6, 10.3, 9.2, 8.2, 7.3, 6.5, 5.8, 5.2, 4.6, 4, 3.4],
      points: [
        [540, 20],
        [486, 44],
        [438, 78],
        [398, 120],
        [368, 172],
        [346, 232],
        [334, 298],
        [334, 366],
        [340, 436],
        [354, 506],
        [368, 570],
        [372, 630],
        [360, 682],
      ],
    },
    // 一级侧枝：角度 46°–52°，直径取父枝的 0.61–0.70，长度错开
    { id: "r-b1", parent: "r-trunk-3", kind: "branch", t: 0.55, angle: 50, pieces: 2, bend: 14, length: 140, widths: [6.3, 5.4] },
    { id: "r-b2", parent: "r-trunk-5", kind: "branch", t: 0.6, angle: 46, pieces: 2, bend: 12, length: 120, widths: [5, 4.3] },
    { id: "r-b3", parent: "r-trunk-7", kind: "branch", t: 0.45, angle: -42, pieces: 2, bend: -10, length: 96, widths: [3.9, 3.3] },
    { id: "r-b4", parent: "r-trunk-9", kind: "branch", t: 0.5, angle: 52, pieces: 2, bend: 16, length: 110, widths: [3.2, 2.7] },
    { id: "r-b5", parent: "r-trunk-11", kind: "branch", t: 0.45, angle: -38, pieces: 1, length: 72, widths: [2.6] },
    // 二级末梢：只挂在侧枝上，长度 34–66，直径 1.8–3.2
    { id: "r-t1", parent: "r-b1", kind: "twig", t: 0.55, angle: -34, pieces: 2, bend: -14, length: 66, widths: [3.2, 2.7] },
    { id: "r-t2", parent: "r-b1", kind: "twig", t: 0.92, angle: 40, pieces: 1, length: 54, widths: [2.9] },
    { id: "r-t3", parent: "r-b2", kind: "twig", t: 0.6, angle: 42, pieces: 2, bend: 12, length: 60, widths: [2.6, 2.2] },
    { id: "r-t4", parent: "r-b2", kind: "twig", t: 0.93, angle: -36, pieces: 1, length: 46, widths: [2.3] },
    { id: "r-t5", parent: "r-b3", kind: "twig", t: 0.55, angle: -40, pieces: 1, length: 50, widths: [2.4] },
    { id: "r-t6", parent: "r-b3", kind: "twig", t: 0.96, angle: 44, pieces: 1, length: 42, widths: [2] },
    { id: "r-t7", parent: "r-b4", kind: "twig", t: 0.6, angle: 38, pieces: 2, bend: 14, length: 54, widths: [2.2, 1.8] },
    { id: "r-t8", parent: "r-b4", kind: "twig", t: 0.93, angle: -42, pieces: 1, length: 40, widths: [1.9] },
    { id: "r-t9", parent: "r-trunk-12", kind: "twig", t: 0.6, angle: -40, pieces: 1, length: 44, widths: [2.2] },
    { id: "r-t10", parent: "r-trunk-10", kind: "twig", t: 0.5, angle: 44, pieces: 1, length: 48, widths: [2.4] },
  ],
};

// ---------------------------------------------------------------------------
// 左侧：主枝自左缘中低处横向入画、向右上一路攀升（顶端优势朝上），
// 侧枝向外上方舒展，末梢再轻微下垂；角度、长度与右侧全部错开。
// ---------------------------------------------------------------------------
const LEFT_SPEC: TreeSpec = {
  limbs: [
    {
      id: "l-trunk",
      parent: null,
      kind: "trunk",
      widths: [12.4, 11, 9.8, 8.7, 7.7, 6.8, 6, 5.3, 4.7, 4.1, 3.5],
      points: [
        [-18, 554],
        [44, 528],
        [96, 492],
        [138, 444],
        [166, 392],
        [184, 336],
        [196, 276],
        [214, 216],
        [238, 164],
        [266, 124],
        [292, 96],
        [310, 74],
      ],
    },
    { id: "l-b1", parent: "l-trunk-2", kind: "branch", t: 0.55, angle: 44, pieces: 2, bend: 12, length: 120, widths: [6, 5.2] },
    { id: "l-b2", parent: "l-trunk-4", kind: "branch", t: 0.55, angle: 52, pieces: 2, bend: 14, length: 110, widths: [4.7, 4] },
    { id: "l-b3", parent: "l-trunk-6", kind: "branch", t: 0.5, angle: 48, pieces: 2, bend: 10, length: 92, widths: [3.8, 3.2] },
    { id: "l-b4", parent: "l-trunk-8", kind: "branch", t: 0.55, angle: -42, pieces: 2, bend: -12, length: 72, widths: [3.1, 2.6] },
    { id: "l-b5", parent: "l-trunk-10", kind: "branch", t: 0.5, angle: 46, pieces: 1, length: 52, widths: [2.5] },
    { id: "l-t1", parent: "l-b1", kind: "twig", t: 0.6, angle: -36, pieces: 2, bend: -12, length: 58, widths: [3, 2.5] },
    { id: "l-t2", parent: "l-b1", kind: "twig", t: 0.92, angle: 42, pieces: 1, length: 46, widths: [2.7] },
    { id: "l-t3", parent: "l-b2", kind: "twig", t: 0.56, angle: 40, pieces: 2, bend: 10, length: 54, widths: [2.5, 2.1] },
    { id: "l-t4", parent: "l-b2", kind: "twig", t: 0.96, angle: -38, pieces: 1, length: 40, widths: [2.2] },
    { id: "l-t5", parent: "l-b3", kind: "twig", t: 0.54, angle: -42, pieces: 1, length: 44, widths: [2.2] },
    { id: "l-t6", parent: "l-b3", kind: "twig", t: 0.96, angle: 40, pieces: 1, length: 38, widths: [1.9] },
    { id: "l-t7", parent: "l-b4", kind: "twig", t: 0.6, angle: 44, pieces: 1, length: 40, widths: [1.9] },
    { id: "l-t8", parent: "l-b5", kind: "twig", t: 0.65, angle: -38, pieces: 1, length: 34, widths: [1.6] },
    { id: "l-t9", parent: "l-trunk-11", kind: "twig", t: 0.55, angle: -40, pieces: 1, length: 40, widths: [2.2] },
    { id: "l-t10", parent: "l-trunk-9", kind: "twig", t: 0.5, angle: 42, pieces: 1, length: 44, widths: [2.4] },
  ],
};

// 背景枝：同一套规则，但更细、更淡、体量更小，衬在前景之后
const RIGHT_FAR_SPEC: TreeSpec = {
  limbs: [
    {
      id: "rf-trunk",
      parent: null,
      kind: "trunk",
      widths: [3, 2.6, 2.2],
      points: [
        [536, 152],
        [470, 152],
        [408, 168],
        [352, 190],
      ],
    },
    { id: "rf-b1", parent: "rf-trunk-2", kind: "branch", t: 0.6, angle: 46, pieces: 1, length: 54, widths: [1.8] },
    { id: "rf-t1", parent: "rf-b1", kind: "twig", t: 0.7, angle: 40, pieces: 1, length: 32, widths: [1.2] },
  ],
};

const LEFT_FAR_SPEC: TreeSpec = {
  limbs: [
    {
      id: "lf-trunk",
      parent: null,
      kind: "trunk",
      widths: [2.8, 2.4, 2],
      points: [
        [96, 268],
        [162, 254],
        [224, 240],
        [282, 230],
      ],
    },
    { id: "lf-b1", parent: "lf-trunk-2", kind: "branch", t: 0.6, angle: -44, pieces: 1, length: 46, widths: [1.6] },
    { id: "lf-t1", parent: "lf-b1", kind: "twig", t: 0.7, angle: 44, pieces: 1, length: 28, widths: [1.1] },
  ],
};

const rightBuilt = buildTree(RIGHT_SPEC);
const leftBuilt = buildTree(LEFT_SPEC);
const rightFarBuilt = buildTree(RIGHT_FAR_SPEC);
const leftFarBuilt = buildTree(LEFT_FAR_SPEC);

/** 花苞/花朵的挂点：只允许挂在末梢枝上（子枝数为 0 的枝） */
type BlossomSpec = { segmentId: string; t: number; size: number; rot: number; kind: BlossomKind };

function placeBlossoms(byId: Map<string, BranchSegment>, specs: BlossomSpec[]): Blossom[] {
  return specs.map((spec) => {
    const seg = byId.get(spec.segmentId);
    if (!seg) throw new Error(`花挂在了不存在的枝段 ${spec.segmentId} 上`);
    const { point } = pointAlong(seg.points, spec.t);
    return {
      x: +point[0].toFixed(1),
      y: +point[1].toFixed(1),
      size: spec.size,
      rot: spec.rot,
      kind: spec.kind,
      segmentId: spec.segmentId,
      t: spec.t,
    };
  });
}

const RIGHT_BLOSSOM_SPECS: BlossomSpec[] = [
  { segmentId: "r-t1", t: 0.95, size: 13, rot: 14, kind: "full" },
  { segmentId: "r-t1", t: 0.78, size: 8, rot: 60, kind: "half" },
  { segmentId: "r-t1", t: 0.6, size: 8, rot: -32, kind: "bud" },
  { segmentId: "r-t2", t: 0.94, size: 11, rot: 28, kind: "half" },
  { segmentId: "r-t2", t: 0.78, size: 8, rot: 52, kind: "half" },
  { segmentId: "r-t2", t: 0.6, size: 7, rot: -22, kind: "bud" },
  { segmentId: "r-t3", t: 0.95, size: 11, rot: -10, kind: "full" },
  { segmentId: "r-t3", t: 0.78, size: 9, rot: 56, kind: "half" },
  { segmentId: "r-t3", t: 0.6, size: 8, rot: 34, kind: "bud" },
  { segmentId: "r-t4", t: 0.93, size: 9, rot: 48, kind: "half" },
  { segmentId: "r-t4", t: 0.76, size: 8, rot: -40, kind: "half" },
  { segmentId: "r-t4", t: 0.6, size: 7, rot: -18, kind: "bud" },
  { segmentId: "r-t5", t: 0.94, size: 12, rot: 22, kind: "full" },
  { segmentId: "r-t5", t: 0.78, size: 9, rot: 44, kind: "half" },
  { segmentId: "r-t5", t: 0.62, size: 8, rot: -32, kind: "bud" },
  { segmentId: "r-t6", t: 0.92, size: 9, rot: -14, kind: "half" },
  { segmentId: "r-t6", t: 0.72, size: 7, rot: 30, kind: "bud" },
  { segmentId: "r-t7", t: 0.95, size: 11, rot: 8, kind: "full" },
  { segmentId: "r-t7", t: 0.75, size: 8, rot: 52, kind: "half" },
  { segmentId: "r-t7", t: 0.6, size: 8, rot: 36, kind: "bud" },
  { segmentId: "r-t8", t: 0.92, size: 8, rot: -24, kind: "bud" },
  { segmentId: "r-t8", t: 0.7, size: 7, rot: 42, kind: "half" },
  { segmentId: "r-t10", t: 0.92, size: 11, rot: -20, kind: "full" },
  { segmentId: "r-t10", t: 0.75, size: 8, rot: 58, kind: "half" },
  { segmentId: "r-t10", t: 0.6, size: 7, rot: 40, kind: "bud" },
  // 主干末端的短梢（r-trunk-12 上还挂着 r-t9，所以花挂到 r-t9 的梢头）
  { segmentId: "r-t9", t: 0.94, size: 12, rot: 10, kind: "full" },
  { segmentId: "r-t9", t: 0.74, size: 8, rot: -34, kind: "bud" },
  { segmentId: "r-t9", t: 0.55, size: 7, rot: 30, kind: "bud" },
];

const LEFT_BLOSSOM_SPECS: BlossomSpec[] = [
  // 左枝更疏，偏花苞与小簇
  { segmentId: "l-t1", t: 0.94, size: 11, rot: 18, kind: "full" },
  { segmentId: "l-t1", t: 0.62, size: 7, rot: -28, kind: "bud" },
  { segmentId: "l-t2", t: 0.92, size: 9, rot: 46, kind: "half" },
  { segmentId: "l-t2", t: 0.7, size: 7, rot: -30, kind: "bud" },
  { segmentId: "l-t3", t: 0.95, size: 10, rot: -12, kind: "full" },
  { segmentId: "l-t3", t: 0.6, size: 7, rot: 32, kind: "bud" },
  { segmentId: "l-t4", t: 0.9, size: 8, rot: 24, kind: "bud" },
  { segmentId: "l-t4", t: 0.72, size: 7, rot: 46, kind: "bud" },
  { segmentId: "l-t5", t: 0.92, size: 10, rot: 8, kind: "half" },
  { segmentId: "l-t6", t: 0.9, size: 8, rot: -20, kind: "bud" },
  { segmentId: "l-t6", t: 0.7, size: 7, rot: -42, kind: "bud" },
  { segmentId: "l-t7", t: 0.92, size: 9, rot: 30, kind: "full" },
  { segmentId: "l-t8", t: 0.92, size: 7, rot: -34, kind: "bud" },
  { segmentId: "l-t8", t: 0.7, size: 7, rot: 40, kind: "bud" },
  { segmentId: "l-t10", t: 0.92, size: 9, rot: 40, kind: "half" },
  // 主干末端同样有短梢 l-t9，花挂在它的梢头
  { segmentId: "l-t9", t: 0.94, size: 12, rot: 12, kind: "full" },
  { segmentId: "l-t9", t: 0.74, size: 7, rot: 36, kind: "bud" },
  { segmentId: "l-t9", t: 0.55, size: 7, rot: -26, kind: "bud" },
];

const RIGHT_FAR_BLOSSOM_SPECS: BlossomSpec[] = [
  { segmentId: "rf-t1", t: 0.9, size: 7, rot: 20, kind: "bud" },
  { segmentId: "rf-trunk-3", t: 0.9, size: 8, rot: -16, kind: "half" },
];

const LEFT_FAR_BLOSSOM_SPECS: BlossomSpec[] = [
  { segmentId: "lf-t1", t: 0.9, size: 6, rot: -22, kind: "bud" },
  { segmentId: "lf-trunk-3", t: 0.9, size: 8, rot: 18, kind: "half" },
];

export type Tree = { segments: BranchSegment[]; byId: Map<string, BranchSegment>; blossoms: Blossom[] };

export const RIGHT_TREE: Tree = {
  segments: rightBuilt.segments,
  byId: rightBuilt.byId,
  blossoms: placeBlossoms(rightBuilt.byId, RIGHT_BLOSSOM_SPECS),
};
export const LEFT_TREE: Tree = {
  segments: leftBuilt.segments,
  byId: leftBuilt.byId,
  blossoms: placeBlossoms(leftBuilt.byId, LEFT_BLOSSOM_SPECS),
};
export const RIGHT_FAR_TREE: Tree = {
  segments: rightFarBuilt.segments,
  byId: rightFarBuilt.byId,
  blossoms: placeBlossoms(rightFarBuilt.byId, RIGHT_FAR_BLOSSOM_SPECS),
};
export const LEFT_FAR_TREE: Tree = {
  segments: leftFarBuilt.segments,
  byId: leftFarBuilt.byId,
  blossoms: placeBlossoms(leftFarBuilt.byId, LEFT_FAR_BLOSSOM_SPECS),
};

/**
 * 绘制顺序：按层级深度从深到浅（子先父后），父枝描边会盖住子枝起点，
 * 接头处不会露缝，也不会出现两个楔形互相穿插的锐刺。
 */
export function paintOrder(segments: ReadonlyArray<BranchSegment>): BranchSegment[] {
  const byId = new Map(segments.map((s) => [s.id, s]));
  const depth = new Map<string, number>();
  const getDepth = (seg: BranchSegment): number => {
    const cached = depth.get(seg.id);
    if (cached !== undefined) return cached;
    let d = 0;
    let cur = seg;
    const chain: BranchSegment[] = [];
    while (cur.parent) {
      const p = byId.get(cur.parent);
      if (!p) break;
      chain.push(cur);
      cur = p;
      d += 1;
    }
    depth.set(seg.id, d);
    for (const c of chain) depth.set(c.id, depth.get(c.id) ?? d);
    return d;
  };
  return [...segments].sort((a, b) => getDepth(b) - getDepth(a));
}

/** 预排好的绘制顺序（子先父后），渲染时直接用，避免每次 render 重新排序 */
export const RIGHT_PAINT = paintOrder(RIGHT_TREE.segments);
export const LEFT_PAINT = paintOrder(LEFT_TREE.segments);
export const RIGHT_FAR_PAINT = paintOrder(RIGHT_FAR_TREE.segments);
export const LEFT_FAR_PAINT = paintOrder(LEFT_FAR_TREE.segments);

export type Violation = { segmentId: string; rule: string; detail: string };

/** 逐段物理自查：父枝存在、起点在父枝轮廓内、直径递减、夹角合理、花只挂末梢 */
export function validateTree(tree: Tree): Violation[] {
  const out: Violation[] = [];
  const { segments, byId, blossoms } = tree;
  // "末梢"按是否还长出下级分叉来算：同一根枝的续段（continue）不算子枝，
  // 所以一根本身分两折的末梢仍然可以开花
  const childCount = new Map<string, number>();
  for (const seg of segments)
    if (seg.parent && seg.kind !== "continue") childCount.set(seg.parent, (childCount.get(seg.parent) ?? 0) + 1);

  for (const seg of segments) {
    if (seg.points.length < 2) {
      out.push({ segmentId: seg.id, rule: "折线至少两点", detail: `${seg.points.length}` });
      continue;
    }
    if (!seg.parent) continue;
    const parent = byId.get(seg.parent);
    if (!parent) {
      out.push({ segmentId: seg.id, rule: "父枝存在", detail: `父枝 ${seg.parent} 找不到` });
      continue;
    }
    const start = seg.points[0];
    const dist = distanceToPolyline(parent.points, start);
    if (dist > parent.width / 2 - 0.5) {
      out.push({
        segmentId: seg.id,
        rule: "起点在父枝轮廓内",
        detail: `距父枝中心线 ${dist.toFixed(1)}，父枝半宽 ${(parent.width / 2).toFixed(1)}`,
      });
    }
    // 附着点必须落在父枝内部而不是端点上（续段靠回退 overlap 满足）
    const attach = nearestT(parent.points, start);
    if (attach < 0.03 || attach > 0.97) {
      out.push({ segmentId: seg.id, rule: "附着点不在父枝端点", detail: `附着比例 ${attach.toFixed(2)}` });
    }
    const ratio = seg.width / parent.width;
    if (seg.kind === "continue") {
      if (ratio > 0.9 || ratio < 0.6) out.push({ segmentId: seg.id, rule: "续段粗细连续", detail: `直径比 ${ratio.toFixed(2)}` });
    } else {
      if (ratio > 0.7) out.push({ segmentId: seg.id, rule: "子枝不粗于父枝", detail: `直径比 ${ratio.toFixed(2)}` });
      if (ratio < 0.4) out.push({ segmentId: seg.id, rule: "子枝不过细", detail: `直径比 ${ratio.toFixed(2)}` });
      const angle = acuteAngle(sub(seg.points[1], seg.points[0]), dirAt(parent.points, nearestT(parent.points, start)));
      if (angle < 28 || angle > 62) out.push({ segmentId: seg.id, rule: "分叉角 30°–60°", detail: `实测 ${angle.toFixed(1)}°` });
    }
  }

  // 同父兄弟间距（只查一级/二级枝，末梢允许密一点）
  const siblings = new Map<string, BranchSegment[]>();
  for (const seg of segments)
    if (seg.parent && seg.kind !== "continue") siblings.set(seg.parent, [...(siblings.get(seg.parent) ?? []), seg]);
  for (const [parentId, list] of siblings) {
    const parent = byId.get(parentId);
    if (!parent || list.length < 2) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const gap =
          Math.abs(nearestT(parent.points, list[i].points[0]) - nearestT(parent.points, list[j].points[0])) *
          polylineLength(parent.points);
        if (gap < 18) out.push({ segmentId: `${list[i].id}/${list[j].id}`, rule: "同侧分叉不过密", detail: `间距 ${gap.toFixed(1)}` });
      }
    }
  }

  // 花只长在末梢
  for (const b of blossoms) {
    const seg = byId.get(b.segmentId);
    if (!seg) {
      out.push({ segmentId: b.segmentId, rule: "花挂枝上", detail: "枝段不存在" });
      continue;
    }
    if ((childCount.get(seg.id) ?? 0) > 0) out.push({ segmentId: b.segmentId, rule: "花只长在末梢", detail: "该段还有子枝" });
    const dist = distanceToPolyline(seg.points, [b.x, b.y]);
    if (dist > seg.width / 2 + 8) out.push({ segmentId: b.segmentId, rule: "花心贴枝", detail: `离枝 ${dist.toFixed(1)}` });
  }
  return out;
}
