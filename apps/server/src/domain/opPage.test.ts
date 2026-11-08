import { describe, expect, it } from 'vitest';
import { LIMITS } from '@whiteboard/shared';
import { boardIdSchema, needsResync, opsQuerySchema, paginatePage } from './opPage.js';

describe('opsQuerySchema', () => {
  it('默认 since=0、limit=分页上限', () => {
    const parsed = opsQuerySchema.parse({});
    expect(parsed.since).toBe(0);
    expect(parsed.limit).toBe(LIMITS.opsPageMax);
  });

  it('接受字符串（查询串）并转成数字', () => {
    expect(opsQuerySchema.parse({ since: '12', limit: '30' })).toEqual({ since: 12, limit: 30 });
  });

  it('拒绝负数、非整数、超上限的 limit', () => {
    expect(opsQuerySchema.safeParse({ since: '-1' }).success).toBe(false);
    expect(opsQuerySchema.safeParse({ since: '1.5' }).success).toBe(false);
    expect(opsQuerySchema.safeParse({ limit: String(LIMITS.opsPageMax + 1) }).success).toBe(false);
  });
});

describe('boardIdSchema', () => {
  it('只接受 12 位白板 ID', () => {
    expect(boardIdSchema.safeParse('c5board00001').success).toBe(true);
    expect(boardIdSchema.safeParse('short').success).toBe(false);
    expect(boardIdSchema.safeParse('c5board0000!').success).toBe(false);
  });
});

describe('needsResync', () => {
  it('差距等于阈值时仍可分页补拉', () => {
    expect(needsResync(0, LIMITS.resyncThreshold)).toBe(false);
  });

  it('差距超过阈值时要求整板重载', () => {
    expect(needsResync(0, LIMITS.resyncThreshold + 1)).toBe(true);
  });

  it('已是最新时不重载', () => {
    expect(needsResync(10, 10)).toBe(false);
  });
});

describe('paginatePage', () => {
  it('多取到一条说明还有下一页', () => {
    const page = paginatePage({ since: 0, limit: 10, rowCount: 11, lastRowSeq: 10 });
    expect(page).toEqual({ hasMore: true, nextSince: 10 });
  });

  it('取回行数不超过 limit 时为最后一页', () => {
    const page = paginatePage({ since: 5, limit: 10, rowCount: 3, lastRowSeq: 8 });
    expect(page).toEqual({ hasMore: false, nextSince: 8 });
  });

  it('空页保持 since 不变', () => {
    expect(paginatePage({ since: 5, limit: 10, rowCount: 0, lastRowSeq: null })).toEqual({
      hasMore: false,
      nextSince: 5,
    });
  });
});
