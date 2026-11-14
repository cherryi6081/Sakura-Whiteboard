import { describe, expect, it } from "vitest";
import { sanitizeReturnTo } from "./returnTo";

describe("sanitizeReturnTo", () => {
  it("接受站内相对路径，保留 path + query + hash", () => {
    expect(sanitizeReturnTo("/boards/trash")).toBe("/boards/trash");
    expect(sanitizeReturnTo("/boards?space=sp_1")).toBe("/boards?space=sp_1");
    expect(sanitizeReturnTo("/board/m3_board_001?from=trash#row-2")).toBe("/board/m3_board_001?from=trash#row-2");
  });

  it("拒绝协议相对地址、反斜杠与绝对 URL", () => {
    expect(sanitizeReturnTo("//evil.example/x")).toBeNull();
    expect(sanitizeReturnTo("/\\evil.example")).toBeNull();
    expect(sanitizeReturnTo("https://evil.example/x")).toBeNull();
    expect(sanitizeReturnTo("javascript:alert(1)")).toBeNull();
    expect(sanitizeReturnTo("boards")).toBeNull();
  });

  it("拒绝登录页自身，避免登录后再被要求登录", () => {
    expect(sanitizeReturnTo("/login")).toBeNull();
    expect(sanitizeReturnTo("/login?returnTo=%2Fboards")).toBeNull();
    expect(sanitizeReturnTo("/register/")).toBeNull();
  });

  it("空值与非法输入返回 null", () => {
    expect(sanitizeReturnTo(null)).toBeNull();
    expect(sanitizeReturnTo(undefined)).toBeNull();
    expect(sanitizeReturnTo("")).toBeNull();
  });
});
