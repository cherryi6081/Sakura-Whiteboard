import { describe, expect, it } from "vitest";
import { parseBoardRoute } from "./route";

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

  it("长度/字符集不符时回到首页，不做任何存储回退", () => {    expect(parseBoardRoute("/board/short")).toEqual({ kind: "index" });
    expect(parseBoardRoute("/board/m3 board 001")).toEqual({ kind: "index" });
    expect(parseBoardRoute("/")).toEqual({ kind: "index" });
    // 旧入口仍然只认地址栏里的 board 参数
    expect(parseBoardRoute("/", "?board=m3_board_001")).toEqual({ kind: "spike" });
    expect(parseBoardRoute("/spike", "?board=m3_board_001")).toEqual({ kind: "spike" });
  });
});
