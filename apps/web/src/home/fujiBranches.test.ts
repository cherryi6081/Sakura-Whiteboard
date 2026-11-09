import { describe, expect, it } from "vitest";
import {
  LEFT_FAR_TREE,
  LEFT_TREE,
  RIGHT_FAR_TREE,
  RIGHT_TREE,
  paintOrder,
  polylineLength,
  validateTree,
  type Tree,
} from "./fujiBranches";

const TREES: Array<[string, Tree]> = [
  ["右侧前景", RIGHT_TREE],
  ["左侧前景", LEFT_TREE],
  ["右侧背景", RIGHT_FAR_TREE],
  ["左侧背景", LEFT_FAR_TREE],
];

describe("樱花枝拓扑", () => {
  it.each(TREES)("%s：逐段物理自查零违规", (_name, tree) => {
    expect(validateTree(tree)).toEqual([]);
  });

  it.each(TREES)("%s：子枝全部先于父枝绘制", (_name, tree) => {
    const order = paintOrder(tree.segments);
    const index = new Map(order.map((seg, i) => [seg.id, i]));
    expect(order).toHaveLength(tree.segments.length);
    for (const seg of order) {
      if (!seg.parent) continue;
      expect(index.get(seg.id)!).toBeLessThan(index.get(seg.parent)!);
    }
  });

  it.each(TREES)("%s：没有悬空枝，任意枝段都能回溯到主干", (_name, tree) => {
    for (const seg of tree.segments) {
      let cursor = seg;
      let hops = 0;
      while (cursor.parent) {
        const parent = tree.byId.get(cursor.parent);
        expect(parent, `${seg.id} 的父链断在 ${cursor.parent}`).toBeDefined();
        cursor = parent!;
        hops += 1;
        expect(hops).toBeLessThan(tree.segments.length);
      }
      expect(cursor.id.startsWith(tree.segments[0].id.split("-")[0])).toBe(true);
    }
  });

  it.each(TREES)("%s：枝段长度与宽度都是正数，续段同向收细", (_name, tree) => {
    for (const seg of tree.segments) {
      expect(polylineLength(seg.points)).toBeGreaterThan(0);
      expect(seg.width).toBeGreaterThan(0);
      if (!seg.parent) continue;
      const parent = tree.byId.get(seg.parent)!;
      expect(seg.width).toBeLessThanOrEqual(parent.width);
    }
  });

  it("增枝增花后的总量符合预期", () => {
    expect(TREES.map(([name, tree]) => [name, tree.segments.length, tree.blossoms.length])).toEqual([
      ["右侧前景", 46, 38],
      ["左侧前景", 44, 27],
      ["右侧背景", 10, 5],
      ["左侧背景", 10, 5],
    ]);
  });

  it("末梢花朵 1–3 朵；前景树三种花型齐全且偏花苞", () => {
    for (const [name, tree] of TREES) {
      const childCount = new Map<string, number>();
      for (const seg of tree.segments)
        if (seg.parent && seg.kind !== "continue") childCount.set(seg.parent, (childCount.get(seg.parent) ?? 0) + 1);
      const per = new Map<string, number>();
      for (const b of tree.blossoms) {
        expect(childCount.get(b.segmentId) ?? 0, `${name} ${b.segmentId} 不是末梢`).toBe(0);
        per.set(b.segmentId, (per.get(b.segmentId) ?? 0) + 1);
      }
      for (const [id, count] of per) expect(count, `${name} ${id}`).toBeLessThanOrEqual(3);
      if (name.includes("前景")) {
        const kinds = [...new Set(tree.blossoms.map((b) => b.kind))].sort();
        expect(kinds).toEqual(["bud", "full", "half"]);
        const buds = tree.blossoms.filter((b) => b.kind === "bud").length;
        const fulls = tree.blossoms.filter((b) => b.kind === "full").length;
        expect(buds).toBeGreaterThanOrEqual(fulls);
      }
    }
  });

  it("输出枝段表（供人工核对层级、直径与角度）", () => {
    for (const [name, tree] of TREES) {
      const rows = tree.segments.map((seg) => {
        const parent = seg.parent ? tree.byId.get(seg.parent) : undefined;
        const ratio = parent ? (seg.width / parent.width).toFixed(2) : "—";
        return {
          tree: name,
          id: seg.id,
          父枝: seg.parent ?? "—",
          层级: seg.kind,
          直径: seg.width,
          直径比: ratio,
          长度: +polylineLength(seg.points).toFixed(1),
        };
      });
      // eslint-disable-next-line no-console
      console.table(rows);
    }
    expect(TREES.length).toBe(4);
  });
});
