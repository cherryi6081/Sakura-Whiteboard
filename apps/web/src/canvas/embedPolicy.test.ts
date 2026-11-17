import { describe, expect, it } from "vitest";
import { isAllowedEmbedUrl } from "./embedPolicy";

describe("isAllowedEmbedUrl", () => {
  it("放行任意合法 https 地址", () => {
    expect(isAllowedEmbedUrl("https://example.com")).toBe(true);
    expect(isAllowedEmbedUrl("https://example.com/path?q=1#hash")).toBe(true);
    expect(isAllowedEmbedUrl("https://sub.example.com:8443/a/b")).toBe(true);
    expect(isAllowedEmbedUrl("  https://example.com  ")).toBe(true);
  });

  it("拦截非 https 协议", () => {
    expect(isAllowedEmbedUrl("http://example.com")).toBe(false);
    expect(isAllowedEmbedUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedEmbedUrl("file:///C:/secret.txt")).toBe(false);
    expect(isAllowedEmbedUrl("data:text/html,<h1>x</h1>")).toBe(false);
  });

  it("拦截空地址与非法地址", () => {
    expect(isAllowedEmbedUrl("")).toBe(false);
    expect(isAllowedEmbedUrl("   ")).toBe(false);
    expect(isAllowedEmbedUrl(null)).toBe(false);
    expect(isAllowedEmbedUrl(undefined)).toBe(false);
    expect(isAllowedEmbedUrl("https://")).toBe(false);
    expect(isAllowedEmbedUrl("https://exa mple.com")).toBe(false);
    expect(isAllowedEmbedUrl("https://example.com\njavascript:alert(1)")).toBe(false);
  });
});
