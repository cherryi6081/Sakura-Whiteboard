import { describe, expect, it } from 'vitest';
import { MIN_GAP, ORDER_STEP, materializeRanks, rankBetween } from './boardOrder.js';

describe('rankBetween', () => {
  it('组内唯一一块时返回首个步长', () => {
    expect(rankBetween(null, null)).toBe(ORDER_STEP);
  });

  it('落在组首取 after 的一半，连续插入会逐步减半', () => {
    expect(rankBetween(null, 2048)).toBe(1024);
    expect(rankBetween(null, 1024)).toBe(512);
    expect(rankBetween(null, 0.0002)).toBeNull();
  });

  it('落在组尾是 before + 步长', () => {
    expect(rankBetween(2048, null)).toBe(3072);
  });

  it('落在两位之间取中点', () => {
    expect(rankBetween(1024, 3072)).toBe(2048);
    expect(rankBetween(1024, 2048)).toBe(1536);
  });

  it('邻居倒序或间隙不足时返回 null，交给调用方整组重排', () => {
    expect(rankBetween(3072, 1024)).toBeNull();
    expect(rankBetween(1024, 1024 + MIN_GAP)).toBeNull();
  });
});

describe('materializeRanks', () => {
  it('按传入顺序写入 1024 的整数倍', () => {
    const map = materializeRanks(['a', 'b', 'c']);
    expect([...map.entries()]).toEqual([
      ['a', 1024],
      ['b', 2048],
      ['c', 3072],
    ]);
  });

  it('空组返回空表', () => {
    expect(materializeRanks([]).size).toBe(0);
  });
});
