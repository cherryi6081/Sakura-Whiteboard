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
