import { describe, expect, it } from "vitest";
import { shouldRegenerateTabId } from "./tabIdentity";

describe("shouldRegenerateTabId（复制标签页重复 tabId 的判定）", () => {
  it("更晚加载的标签让路（重新生成）", () => {
    expect(shouldRegenerateTabId({ bootedAt: 2000, nonce: "n_a" }, { bootedAt: 1000, nonce: "n_b" })).toBe(true);
    expect(shouldRegenerateTabId({ bootedAt: 1000, nonce: "n_a" }, { bootedAt: 2000, nonce: "n_b" })).toBe(false);
  });

  it("bootedAt 平局时按 nonce 字典序，两个标签判定互补", () => {
    const self = { bootedAt: 1000, nonce: "n_b" };
    const peer = { bootedAt: 1000, nonce: "n_a" };
    expect(shouldRegenerateTabId(self, peer)).toBe(true);
    expect(shouldRegenerateTabId(peer, self)).toBe(false);
  });

  it("自己与自己（同 nonce）不会判定为重复", () => {
    const self = { bootedAt: 1000, nonce: "n_a" };
    expect(shouldRegenerateTabId(self, self)).toBe(false);
  });
});
