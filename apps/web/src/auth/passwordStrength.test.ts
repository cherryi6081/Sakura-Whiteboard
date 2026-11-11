import { describe, expect, it } from "vitest";
import {
  assessPassword,
  levelBars,
  levelLabel,
  PASSWORD_LEVEL_BITS,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "@whiteboard/shared";

/**
 * 密码强度分级（packages/shared/src/password.ts）的样本覆盖。
 * 放在 web 包里跑：shared 没有独立的 test runner，web 的 vitest 会先 build shared 再引 dist。
 */
describe("密码强度分级", () => {
  it("纯数字最多「一般」；10 位纯数字为「弱」", () => {
    const ten = assessPassword("8473625190");
    expect(ten.level).toBe("weak");
    expect(ten.reasons).toContain("只有数字");

    // 16 位纯数字虽然长度够，但数字类池只有 10，按规则封顶在「一般」
    expect(assessPassword("8473625190483726").level).toBe("fair");
  });

  it("纯字母只有一类字符，不给顶档", () => {
    const lower = assessPassword("kfjdhgpoeiru");
    expect(lower.level).toBe("fair");
    expect(lower.reasons).toContain("只有小写字母");
    expect(lower.score).toBeLessThan(PASSWORD_LEVEL_BITS.strong);
  });

  it("长度够但含 qwerty 仍判「弱」", () => {
    const qwerty = assessPassword("kR7#mQ2qwerty");
    expect(qwerty.level).toBe("weak");
    expect(qwerty.reasons.join("、")).toContain("qwerty");
  });

  it("Passw0rd! 归一化后命中常见密码，且阻断注册", () => {
    const leet = assessPassword("Passw0rd!");
    expect(leet.level).toBe("weak");
    expect(leet.blockers).toContain("这个密码太常见，换一个");
  });

  it("随机 12 位混合字符为「强」", () => {
    const random = assessPassword("kR7#mQ2!vL9x");
    expect(random.level).toBe("very-strong");
    expect(random.score).toBeGreaterThanOrEqual(PASSWORD_LEVEL_BITS.veryStrong);
  });

  it("超长纯同一字符仍为「弱」", () => {
    const same = assessPassword("a".repeat(20));
    expect(same.level).toBe("weak");
    expect(same.reasons).toContain("含重复字符");
  });

  it("递增递减序列与重复片段被当作可预测片段", () => {
    expect(assessPassword("9876543210").level).toBe("weak");
    expect(assessPassword("Abcd1234Efgh").level).toBe("weak");

    const repeated = assessPassword("abcabcabcabc");
    expect(repeated.level).toBe("weak");
    expect(repeated.reasons).toContain("含重复片段");
  });

  it("加长单一字符类不如增加字符种类", () => {
    const longerLower = assessPassword("kfjdhgpoeiruxy"); // 14 位纯小写
    const shorterMixed = assessPassword("kFj7hgPoeiru"); // 12 位三类
    expect(longerLower.score).toBeLessThan(shorterMixed.score);
  });

  it("邮箱前缀、长度越界属于硬门槛", () => {
    const email = assessPassword("alicealice12", { email: "alice@example.com" });
    expect(email.blockers.some((item) => item.includes("邮箱前缀"))).toBe(true);

    expect(assessPassword("Ab1!").blockers[0]).toContain(`密码至少 ${PASSWORD_MIN_LENGTH} 位`);
    expect(assessPassword("aB3$".repeat(9)).blockers[0]).toContain(`密码最多 ${PASSWORD_MAX_LENGTH} 位`);
  });

  it("四档与条格数、文案一一对应，分数不越档", () => {
    const levels = ["weak", "fair", "strong", "very-strong"] as const;
    expect(levels.map(levelBars)).toEqual([1, 2, 3, 4]);
    expect(levels.map(levelLabel)).toEqual(["弱", "一般", "较强", "强"]);

    const fair = assessPassword("8473625190483726");
    expect(fair.score).toBeGreaterThanOrEqual(PASSWORD_LEVEL_BITS.fair);
    expect(fair.score).toBeLessThan(PASSWORD_LEVEL_BITS.strong);
  });
});
