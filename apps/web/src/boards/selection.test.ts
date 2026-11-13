import { describe, expect, it } from "vitest";
import {
  allPinned,
  gridColumnsForWidth,
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

describe("gridColumnsForWidth", () => {
  it("与 CSS 断点一致", () => {
    expect(gridColumnsForWidth(1440)).toBe(5);
    expect(gridColumnsForWidth(1024)).toBe(5);
    expect(gridColumnsForWidth(1023)).toBe(3);
    expect(gridColumnsForWidth(701)).toBe(3);
    expect(gridColumnsForWidth(700)).toBe(1);
    expect(gridColumnsForWidth(390)).toBe(1);
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
