import { describe, expect, it } from "vitest";
import {
  allPinned,
  boardsLayout,
  pinTargets,
  rangeIds,
  selectionState,
  trashTargets,
  type SelectableCard,
} from "./selection";

const card = (id: string, extra: Partial<SelectableCard> = {}): SelectableCard => ({
  id,
  title: id,
  role: "owner",
  ...extra,
});

describe("boardsLayout", () => {
  it("宽度优先：四列均分内容区并铺满（1440×950 内容区 1200 → 每列 288）", () => {
    expect(boardsLayout({ width: 1200 })).toEqual({ cardWidth: 288, columns: 4 });
    expect(boardsLayout({ width: 853 })).toEqual({ cardWidth: 201, columns: 4 });
  });

  it("宽度不够 4 列时减少列数，卡片仍铺满", () => {
    expect(boardsLayout({ width: 600 })).toEqual({ cardWidth: 189, columns: 3 });
    expect(boardsLayout({ width: 400 })).toEqual({ cardWidth: 192, columns: 2 });
    expect(boardsLayout({ width: 200 })).toEqual({ cardWidth: 200, columns: 1 });
  });

  it("列数断点：608/452/296 是各档的第一档宽度", () => {
    expect(boardsLayout({ width: 608 })).toEqual({ cardWidth: 140, columns: 4 });
    expect(boardsLayout({ width: 607 })).toEqual({ cardWidth: 191, columns: 3 });
    expect(boardsLayout({ width: 452 })).toEqual({ cardWidth: 140, columns: 3 });
    expect(boardsLayout({ width: 451 })).toEqual({ cardWidth: 217, columns: 2 });
    expect(boardsLayout({ width: 296 })).toEqual({ cardWidth: 140, columns: 2 });
    expect(boardsLayout({ width: 295 })).toEqual({ cardWidth: 295, columns: 1 });
  });

  it("卡片铺满内容区：整除余数小于列数（居中均分，不压卡宽）", () => {
    for (const width of [1200, 853, 607, 451, 295]) {
      const { cardWidth, columns } = boardsLayout({ width });
      const used = cardWidth * columns + (columns - 1) * 16;
      const rest = width - used;
      expect(rest).toBeGreaterThanOrEqual(0);
      expect(rest).toBeLessThan(columns);
    }
  });
});

describe("selectionState", () => {
  it("空页 / 未选 / 部分 / 全选", () => {
    expect(selectionState([], new Set())).toBe("none");
    expect(selectionState(["a", "b"], new Set())).toBe("none");
    expect(selectionState(["a", "b"], new Set(["a"]))).toBe("some");
    expect(selectionState(["a", "b"], new Set(["a", "b"]))).toBe("all");
  });
});

describe("rangeIds", () => {
  const order = ["a", "b", "c", "d", "e", "f"];

  it("从锚点到目标，反向也包含两端", () => {
    expect(rangeIds(order, "b", "e")).toEqual(["b", "c", "d", "e"]);
    expect(rangeIds(order, "e", "b")).toEqual(["b", "c", "d", "e"]);
  });

  it("无锚点退化为单选，目标不在本页返回空", () => {
    expect(rangeIds(order, null, "c")).toEqual(["c"]);
    expect(rangeIds(order, "b", "zzz")).toEqual([]);
  });
});

describe("批量目标权限", () => {
  it("删除认 owner（含游客临时板），editor/viewer 跳过", () => {
    const cards = [
      card("owner"),
      card("editor", { role: "editor" }),
      card("viewer", { role: "viewer" }),
      card("guest", { guest: true }),
    ];
    const result = trashTargets(cards, new Set(cards.map((item) => item.id)));
    expect(result.targets.map((item) => item.id)).toEqual(["owner", "guest"]);
    expect(result.skipped.map((item) => item.id)).toEqual(["editor", "viewer"]);
  });

  it("置顶认 owner/editor，viewer 跳过", () => {
    const cards = [card("owner"), card("editor", { role: "editor" }), card("viewer", { role: "viewer" })];
    const result = pinTargets(cards, new Set(cards.map((item) => item.id)));
    expect(result.targets.map((item) => item.id)).toEqual(["owner", "editor"]);
    expect(result.skipped.map((item) => item.id)).toEqual(["viewer"]);
  });

  it("全部置顶时才建议取消置顶", () => {
    const cards = [card("a", { pinned: true }), card("b", { pinned: true }), card("c", { pinned: false })];
    expect(allPinned(cards, new Set(["a", "b"]))).toBe(true);
    expect(allPinned(cards, new Set(["a", "c"]))).toBe(false);
    expect(allPinned(cards, new Set())).toBe(false);
  });
});
