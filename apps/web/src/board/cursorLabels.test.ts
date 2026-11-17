import { describe, expect, it } from "vitest";
import { buildCursorLabels, type LabeledCursor } from "./cursorLabels";

const cursor = (overrides: Partial<LabeledCursor> & Pick<LabeledCursor, "connectionId">): LabeledCursor => ({
  color: "#A85C7C",
  displayName: "张三",
  joinedAt: 1000,
  ...overrides,
});

describe("buildCursorLabels", () => {
  it("同色第一条只显示昵称，第 2 条起追加序号", () => {
    const labels = buildCursorLabels([
      cursor({ connectionId: "sock_a", joinedAt: 1000 }),
      cursor({ connectionId: "sock_b", joinedAt: 2000 }),
      cursor({ connectionId: "sock_c", joinedAt: 3000 }),
    ]);
    expect(labels.get("sock_a")).toBe("张三");
    expect(labels.get("sock_b")).toBe("张三 · 2");
    expect(labels.get("sock_c")).toBe("张三 · 3");
  });

  it("按加入顺序稳定排序，与输入数组顺序无关", () => {
    const items = [
      cursor({ connectionId: "sock_late", joinedAt: 3000 }),
      cursor({ connectionId: "sock_early", joinedAt: 1000 }),
      cursor({ connectionId: "sock_mid", joinedAt: 2000 }),
    ];
    const forward = buildCursorLabels(items);
    const reversed = buildCursorLabels([...items].reverse());
    for (const id of ["sock_early", "sock_mid", "sock_late"]) {
      expect(forward.get(id)).toBe(reversed.get(id));
    }
    expect(forward.get("sock_early")).toBe("张三");
    expect(forward.get("sock_late")).toBe("张三 · 3");
  });

  it("加入时间相同用 connectionId 兜底，顺序确定", () => {
    const a = buildCursorLabels([
      cursor({ connectionId: "sock_b", joinedAt: 1000 }),
      cursor({ connectionId: "sock_a", joinedAt: 1000 }),
    ]);
    const b = buildCursorLabels([
      cursor({ connectionId: "sock_a", joinedAt: 1000 }),
      cursor({ connectionId: "sock_b", joinedAt: 1000 }),
    ]);
    expect(a.get("sock_a")).toBe("张三");
    expect(a.get("sock_b")).toBe("张三 · 2");
    expect(b.get("sock_a")).toBe("张三");
    expect(b.get("sock_b")).toBe("张三 · 2");
  });

  it("不同颜色各自独立编号，互不影响", () => {
    const labels = buildCursorLabels([
      cursor({ connectionId: "red_1", color: "#A85C7C", displayName: "张三", joinedAt: 1000 }),
      cursor({ connectionId: "blue_1", color: "#7C8AA8", displayName: "李四", joinedAt: 2000 }),
      cursor({ connectionId: "red_2", color: "#A85C7C", displayName: "王五", joinedAt: 3000 }),
    ]);
    expect(labels.get("red_1")).toBe("张三");
    expect(labels.get("blue_1")).toBe("李四");
    expect(labels.get("red_2")).toBe("王五 · 2");
  });

  it("同一用户的两个标签同色时，也能靠序号区分", () => {
    const labels = buildCursorLabels([
      cursor({ connectionId: "tab_1", joinedAt: 1000 }),
      cursor({ connectionId: "tab_2", joinedAt: 1200 }),
    ]);
    expect([...labels.values()]).toEqual(["张三", "张三 · 2"]);
  });

  it("昵称为空时回退为「协作者」", () => {
    const labels = buildCursorLabels([cursor({ connectionId: "sock_x", displayName: "" })]);
    expect(labels.get("sock_x")).toBe("协作者");
  });
});
