import { describe, expect, it } from 'vitest';
import { msUntilNextCleanup } from './retention.js';

describe('msUntilNextCleanup', () => {
  it('03:00 之前返回距当天 03:00 的时长', () => {
    // 2026-11-12 02:00 +08:00
    const now = new Date('2026-11-11T18:00:00.000Z');
    expect(msUntilNextCleanup(now)).toBe(60 * 60 * 1000);
  });

  it('03:00 之后顺延到次日 03:00', () => {
    // 2026-11-12 04:00 +08:00
    const now = new Date('2026-11-11T20:00:00.000Z');
    expect(msUntilNextCleanup(now)).toBe(23 * 60 * 60 * 1000);
  });

  it('恰好 03:00 时排到明天，避免同一分钟内重复执行', () => {
    const now = new Date('2026-11-11T19:00:00.000Z');
    expect(msUntilNextCleanup(now)).toBe(24 * 60 * 60 * 1000);
  });

  it('容器时区（UTC）不影响结果', () => {
    // 2026-11-11 23:30 +08:00 = 15:30Z
    const now = new Date('2026-11-11T15:30:00.000Z');
    expect(msUntilNextCleanup(now)).toBe(3.5 * 60 * 60 * 1000);
  });
});
