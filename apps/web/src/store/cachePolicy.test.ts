import { describe, expect, it } from 'vitest';
import {
  CACHE_DB_NAME,
  CACHE_TTL_MS,
  ELEMENT_KEY_PATH,
  decideResync,
  elementKey,
  isCacheExpired,
} from './cachePolicy';

describe('缓存键设计', () => {
  it('元素主键是 [boardId, elementId] 复合键', () => {
    expect(ELEMENT_KEY_PATH).toEqual(['boardId', 'elementId']);
    expect(elementKey('board000001', 'el-1')).toEqual(['board000001', 'el-1']);
  });

  it('自建库名不与 Excalidraw 的默认键冲突', () => {
    expect(CACHE_DB_NAME).toBe('wb-cache');
  });
});

describe('isCacheExpired', () => {
  const now = 1_800_000_000_000;

  it('7 天内保留', () => {
    expect(isCacheExpired(now - 1000, now)).toBe(false);
    expect(isCacheExpired(now - CACHE_TTL_MS, now)).toBe(false);
  });

  it('超过 7 天删除', () => {
    expect(isCacheExpired(now - CACHE_TTL_MS - 1000, now)).toBe(true);
  });

  it('缺失/非法时间视作过期', () => {
    expect(isCacheExpired(0, now)).toBe(true);
    expect(isCacheExpired(Number.NaN, now)).toBe(true);
  });
});

describe('decideResync', () => {
  it('落后不超过阈值时走 since 补拉', () => {
    expect(decideResync(0, 500)).toBe(false);
    expect(decideResync(100, 100)).toBe(false);
  });

  it('落后超过阈值时回退整板快照', () => {
    expect(decideResync(0, 501)).toBe(true);
  });
});
