import { describe, expect, it } from "vitest";
import {
  effectivePurgeAt,
  formatDeletedAt,
  formatPurgeTitle,
  isExpiringSoon,
  remainingTrashDays,
  trashPill,
  trashTone,
} from "./trashMeta";

/** 2026-11-12 12:00 +08:00 */
const NOW = Date.parse("2026-11-12T04:00:00.000Z");

describe("effectivePurgeAt", () => {
  it("14:22 删除的板顺延到第 31 天 03:00 清理", () => {
    // 2026-10-13 14:22 +08:00 → +30 天 = 2026-11-12 14:22 +08:00
    const purgeAt = "2026-11-12T06:22:00.000Z";
    expect(new Date(effectivePurgeAt(purgeAt)).toISOString()).toBe("2026-11-12T19:00:00.000Z");
  });

  it("恰好 03:00 到期就在当天 03:00 清理，不再顺延", () => {
    const purgeAt = "2026-11-11T19:00:00.000Z"; // 2026-11-12 03:00 +08:00
    expect(new Date(effectivePurgeAt(purgeAt)).toISOString()).toBe("2026-11-11T19:00:00.000Z");
  });
});

describe("remainingTrashDays", () => {
  it("不足 24 小时显示今天到期", () => {
    // 实际清理 2026-11-13 03:00 +08:00（NOW 之后 15 小时）
    expect(remainingTrashDays("2026-11-12T19:00:00.000Z", NOW)).toBe(0);
    expect(trashTone(0)).toBe("danger");
  });

  it("刚删除显示剩 30 天而不是 31 天", () => {
    // 2026-11-12 17:05 +08 删除 → +30 天 17:05 → 实际清理 12-13 03:00（31 天 15 小时）
    // 但按「完整保留天数」应显示 30 天
    expect(remainingTrashDays("2026-12-12T09:05:00.000Z", Date.parse("2026-11-12T09:05:00.000Z"))).toBe(30);
  });

  it("超过 7 天进入普通态", () => {
    // 实际清理 2026-11-21 03:00 +08:00 → 8 天 15 小时，向下取整 8 天
    expect(remainingTrashDays("2026-11-20T19:00:00.000Z", NOW)).toBe(8);
    expect(trashTone(8)).toBe("normal");
    expect(trashTone(7)).toBe("warn");
    // 设计稿：剩 1–2 天仍是 warning，只有「今天到期」（最后 24 小时）才转 danger
    expect(trashTone(1)).toBe("warn");
  });

  it("已过期的板显示今天到期而不是负数", () => {
    expect(remainingTrashDays("2026-11-01T00:00:00.000Z", NOW)).toBe(0);
    expect(trashPill("2026-11-01T00:00:00.000Z", NOW)).toEqual({ label: "今天到期", tone: "danger" });
  });
});

describe("文案与时区", () => {
  it("列表时间按本地时区显示月-日 时:分", () => {
    // 2026-11-10 14:22 +08:00 = 06:22Z
    expect(formatDeletedAt("2026-11-10T06:22:00.000Z")).toMatch(/^11-10 (14|06):22$/);
  });

  it("tooltip 精确到实际清理日 03:00", () => {
    expect(formatPurgeTitle("2026-11-12T06:22:00.000Z")).toContain("03:00");
  });

  it("7 天内到期筛选与文案一致", () => {
    // 实际清理 2026-11-18 03:00 +08:00 → 剩 6 天
    expect(isExpiringSoon("2026-11-17T19:00:00.000Z", NOW)).toBe(true);
    expect(isExpiringSoon("2026-11-25T02:00:00.000Z", NOW)).toBe(false);
  });
});
