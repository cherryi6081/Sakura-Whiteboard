import { describe, expect, it } from "vitest";
import { electWriter } from "./writerLease";

describe("electWriter（Web Locks 不可用时的降级选举）", () => {
  it("最早打开的标签胜出", () => {
    expect(
      electWriter([
        { tabId: "tab_new", bootedAt: 2000 },
        { tabId: "tab_old", bootedAt: 1000 },
      ]),
    ).toBe("tab_old");
  });

  it("bootedAt 相同按 tabId 字典序，保证各标签结果一致", () => {
    expect(
      electWriter([
        { tabId: "tab_b", bootedAt: 1000 },
        { tabId: "tab_a", bootedAt: 1000 },
      ]),
    ).toBe("tab_a");
  });

  it("没有候选时返回 null", () => {
    expect(electWriter([])).toBeNull();
  });
});
