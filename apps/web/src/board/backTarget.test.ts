import { describe, expect, it } from "vitest";
import { boardHref, isBoardListPath, resolveBackHref } from "./backTarget";

const ORIGIN = "http://127.0.0.1:5173";

describe("isBoardListPath", () => {
  it("只认白板列表与回收站", () => {
    expect(isBoardListPath("/boards")).toBe(true);
    expect(isBoardListPath("/boards/")).toBe(true);
    expect(isBoardListPath("/boards?space=sp_1")).toBe(true);
    expect(isBoardListPath("/boards/trash")).toBe(true);
    expect(isBoardListPath("/boards/trash?filter=all")).toBe(true);
    expect(isBoardListPath("/board/m3_board_001")).toBe(false);
    expect(isBoardListPath("/")).toBe(false);
    expect(isBoardListPath("/boards/trashcan")).toBe(false);
  });
});

describe("boardHref", () => {
  it("个人列表不写 from，保持链接干净", () => {
    expect(boardHref("m3_board_001", "/boards")).toBe("/board/m3_board_001");
  });

  it("团队空间把 ?space= 编码进 from", () => {
    expect(boardHref("m3_board_001", "/boards?space=sp_1")).toBe(
      "/board/m3_board_001?from=%2Fboards%3Fspace%3Dsp_1",
    );
    expect(boardHref("m3_board_001", "/boards/trash")).toBe("/board/m3_board_001?from=%2Fboards%2Ftrash");
  });
});

describe("resolveBackHref", () => {
  it("优先用 ?from（团队空间完整带回）", () => {
    const href = resolveBackHref({
      search: "?from=%2Fboards%3Fspace%3Dsp_1",
      referrer: `${ORIGIN}/boards`,
      origin: ORIGIN,
    });
    expect(href).toBe("/boards?space=sp_1");
  });

  it("没有 from 时用同源列表 referrer", () => {
    expect(
      resolveBackHref({ search: "", referrer: `${ORIGIN}/boards?space=sp_2`, origin: ORIGIN }),
    ).toBe("/boards?space=sp_2");
  });

  it("站外 / 非列表来源一律回 /boards", () => {
    expect(resolveBackHref({ search: "", referrer: "https://evil.example/boards", origin: ORIGIN })).toBe(
      "/boards",
    );
    expect(resolveBackHref({ search: "", referrer: `${ORIGIN}/board/other_board`, origin: ORIGIN })).toBe(
      "/boards",
    );
    expect(resolveBackHref({ search: "", referrer: "", origin: ORIGIN })).toBe("/boards");
  });

  it("非法 from 不生效，退回 referrer / 兜底", () => {
    expect(
      resolveBackHref({
        search: "?from=https%3A%2F%2Fevil.example%2Fx",
        referrer: `${ORIGIN}/boards`,
        origin: ORIGIN,
      }),
    ).toBe("/boards");
    expect(
      resolveBackHref({ search: "?from=%2Fboard%2Fother", referrer: "", origin: ORIGIN }),
    ).toBe("/boards");
  });
});
