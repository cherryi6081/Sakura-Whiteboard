import { describe, expect, it } from "vitest";
import { parseBoardRoute } from "./route";

describe("parseBoardRoute", () => {
  it("只从路径解析 boardId", () => {
    expect(parseBoardRoute("/board/m3_board_001")).toEqual({ kind: "board", boardId: "m3_board_001" });
    expect(parseBoardRoute("/board/m3_board_001/")).toEqual({ kind: "board", boardId: "m3_board_001" });
  });

  it("长度/字符集不符时回到首页，不做任何存储回退", () => {
    expect(parseBoardRoute("/board/short")).toEqual({ kind: "index" });
    expect(parseBoardRoute("/board/m3 board 001")).toEqual({ kind: "index" });
    expect(parseBoardRoute("/")).toEqual({ kind: "index" });
    // 旧入口仍然只认地址栏里的 board 参数
    expect(parseBoardRoute("/", "?board=m3_board_001")).toEqual({ kind: "spike" });
    expect(parseBoardRoute("/spike", "?board=m3_board_001")).toEqual({ kind: "spike" });
  });
});
