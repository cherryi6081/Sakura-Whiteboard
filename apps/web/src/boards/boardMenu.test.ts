import { describe, expect, it } from "vitest";
import { buildBoardMenu, placeFloatingMenu, type BoardMenuItem } from "./boardMenu";

function flat(groups: ReturnType<typeof buildBoardMenu>): BoardMenuItem[] {
  return groups.flatMap((group) => group.items);
}

function item(groups: ReturnType<typeof buildBoardMenu>, key: string): BoardMenuItem {
  const found = flat(groups).find((entry) => entry.key === key);
  if (!found) throw new Error(`missing menu item: ${key}`);
  return found;
}

describe("buildBoardMenu", () => {
  it("owner 有 3 组 8 项，危险项独占最后一组", () => {
    const groups = buildBoardMenu({ role: "owner", pinned: false });
    expect(groups.map((group) => group.items.length)).toEqual([4, 3, 1]);
    expect(flat(groups).map((entry) => entry.key)).toEqual([
      "open",
      "rename",
      "move-to",
      "pin",
      "copy-link",
      "duplicate",
      "members",
      "trash",
    ]);
    expect(groups[2]?.danger).toBe(true);
  });

  it("置顶时文案与图标切换为取消置顶", () => {
    const pinned = buildBoardMenu({ role: "owner", pinned: true });
    expect(item(pinned, "pin").label).toBe("取消置顶");
    expect(item(pinned, "pin").icon).toBe("pinOff");
    expect(item(buildBoardMenu({ role: "owner", pinned: false }), "pin").label).toBe("置顶");
  });

  it("editor 可改名与置顶，但只能删自己创建的板，也看不到协作者", () => {
    const groups = buildBoardMenu({ role: "editor", pinned: false });
    expect(item(groups, "rename").disabledReason).toBeUndefined();
    expect(item(groups, "pin").disabledReason).toBeUndefined();
    expect(item(groups, "trash").disabledReason).toBe("仅自己创建的");
    expect(
      item(buildBoardMenu({ role: "editor", pinned: false, isOwn: true }), "trash").disabledReason,
    ).toBeUndefined();
    expect(flat(groups).some((entry) => entry.key === "members")).toBe(false);
  });

  it("viewer 的改名/置顶/删除都禁用并写明原因，项不隐藏", () => {
    const groups = buildBoardMenu({ role: "viewer", pinned: false });
    expect(item(groups, "rename").disabledReason).toBe("只读");
    expect(item(groups, "pin").disabledReason).toBe("只读");
    expect(item(groups, "trash").disabledReason).toBe("只读");
    expect(flat(groups)).toHaveLength(7);
  });

  it("游客可置顶（本机）、可删除临时板（物理删除，不可恢复），改名禁用", () => {
    const groups = buildBoardMenu({ role: "owner", pinned: false, guest: true });
    expect(item(groups, "pin").disabledReason).toBeUndefined();
    expect(item(groups, "rename").disabledReason).toBe("登录后可用");
    expect(item(groups, "trash").disabledReason).toBeUndefined();
    expect(item(groups, "trash").label).toBe("删除临时板");
    expect(item(groups, "trash").tail).toBe("不可恢复");
    expect(flat(groups).some((entry) => entry.key === "members")).toBe(false);
  });

  it("登录用户仍然是移入回收站，而不是物理删除", () => {
    const groups = buildBoardMenu({ role: "owner", pinned: false });
    expect(item(groups, "trash").label).toBe("移到回收站");
    expect(item(groups, "trash").tail).toBeUndefined();
  });

  it("创建副本本期统一禁用，协作者二级菜单移除项禁用", () => {
    const groups = buildBoardMenu({ role: "owner", pinned: false });
    expect(item(groups, "duplicate").disabledReason).toBe("暂不支持");
    const members = item(groups, "members");
    expect(members.submenu?.map((entry) => entry.key)).toEqual(["invite", "remove-member"]);
    expect(members.submenu?.[0]?.disabledReason).toBeUndefined();
    expect(members.submenu?.[1]?.disabledReason).toBe("暂无成员管理");
  });
});

describe("placeFloatingMenu", () => {
  const size = { width: 232, height: 325 };
  const viewport = { width: 1440, height: 900 };

  it("鼠标锚点默认落在右下 4px", () => {
    expect(placeFloatingMenu({ type: "pointer", x: 200, y: 300 }, size, viewport)).toMatchObject({
      left: 204,
      top: 304,
    });
  });

  it("右/下放不下时反向翻转", () => {
    const placed = placeFloatingMenu({ type: "pointer", x: 1360, y: 700 }, size, viewport);
    expect(placed.left).toBe(1360 - 232 - 4);
    expect(placed.top).toBe(700 - 325 - 4);
  });

  it("翻转后仍越界时夹到 8px 安全边距", () => {
    const placed = placeFloatingMenu(
      { type: "pointer", x: 12, y: 20 },
      { width: 232, height: 1200 },
      { width: 200, height: 900 },
    );
    expect(placed.left).toBe(8);
    expect(placed.top).toBe(8);
    expect(placed.maxHeight).toBe(900 - 16);
  });

  it("按钮锚点右缘对齐按钮，向下 6px", () => {
    const placed = placeFloatingMenu(
      { type: "button", left: 500, right: 524, top: 200, bottom: 224 },
      size,
      viewport,
    );
    expect(placed.left).toBe(524 - 232);
    expect(placed.top).toBe(230);
  });

  it("按钮下方放不下时翻到上方", () => {
    const placed = placeFloatingMenu(
      { type: "button", left: 500, right: 524, top: 800, bottom: 824 },
      size,
      viewport,
    );
    expect(placed.top).toBe(800 - 325 - 6);
  });

  it("触屏 12px 边距生效", () => {
    const placed = placeFloatingMenu({ type: "pointer", x: 2, y: 2 }, size, viewport, 12);
    expect(placed.left).toBe(12);
    expect(placed.top).toBe(12);
  });
});
