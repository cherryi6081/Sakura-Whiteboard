import { describe, expect, it } from "vitest";
import { isRestrictedPath, parseBoardRoute } from "./route";

describe("parseBoardRoute", () => {
  it("只从路径解析 boardId", () => {
    expect(parseBoardRoute("/board/m3_board_001")).toEqual({ kind: "board", boardId: "m3_board_001" });
    expect(parseBoardRoute("/board/m3_board_001/")).toEqual({ kind: "board", boardId: "m3_board_001" });
  });

  it("回收站是独立路由，不落到列表页", () => {
    expect(parseBoardRoute("/boards/trash")).toEqual({ kind: "trash" });
    expect(parseBoardRoute("/boards/trash/")).toEqual({ kind: "trash" });
    expect(parseBoardRoute("/boards")).toEqual({ kind: "boards" });
  });

  it("邀请链接是独立路由，token 不合法则回首页", () => {
    expect(parseBoardRoute("/join/AbCdEfGhIjKlMnOpQrStUvWx")).toEqual({
      kind: "join",
      token: "AbCdEfGhIjKlMnOpQrStUvWx",
    });
    expect(parseBoardRoute("/join/short")).toEqual({ kind: "index" });
  });

  it("登录页回跳：returnTo 优先，旧 next 兼容，站外地址一律丢弃", () => {
    expect(parseBoardRoute("/login", "?returnTo=%2Fboards%2Ftrash")).toEqual({
      kind: "auth",
      mode: "login",
      next: "/boards/trash",
    });
    expect(parseBoardRoute("/register", "?next=%2Fboards%2Ftrash")).toEqual({
      kind: "auth",
      mode: "register",
      next: "/boards/trash",
    });
    // returnTo 非法时回退到 next
    expect(parseBoardRoute("/login", "?returnTo=https%3A%2F%2Fevil.example&next=%2Fboards")).toEqual({
      kind: "auth",
      mode: "login",
      next: "/boards",
    });
    expect(parseBoardRoute("/login", "?returnTo=%2F%2Fevil.example")).toEqual({
      kind: "auth",
      mode: "login",
      next: null,
    });
    expect(parseBoardRoute("/login", "?returnTo=%2Flogin")).toEqual({
      kind: "auth",
      mode: "login",
      next: null,
    });
  });

  it("受限页判定只认回收站（/boards 保持开放）", () => {
    expect(isRestrictedPath("/boards/trash")).toBe(true);
    expect(isRestrictedPath("/boards/trash/?x=1")).toBe(true);
    expect(isRestrictedPath("/boards")).toBe(false);
    expect(isRestrictedPath("/boards/trashcan")).toBe(false);
    expect(isRestrictedPath("/board/m3_board_001")).toBe(false);
  });

  it("长度/字符集不符时回到首页，不做任何存储回退", () => {    expect(parseBoardRoute("/board/short")).toEqual({ kind: "index" });
    expect(parseBoardRoute("/board/m3 board 001")).toEqual({ kind: "index" });
    expect(parseBoardRoute("/")).toEqual({ kind: "index" });
    // 旧入口仍然只认地址栏里的 board 参数
    expect(parseBoardRoute("/", "?board=m3_board_001")).toEqual({ kind: "spike" });
    expect(parseBoardRoute("/spike", "?board=m3_board_001")).toEqual({ kind: "spike" });
  });
});
