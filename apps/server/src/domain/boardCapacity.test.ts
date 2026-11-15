import { describe, expect, it } from 'vitest';
import {
  BOARD_CAPACITY,
  EVICTION_POLICY,
  isEvictionEligible,
  listEvictionCandidates,
  pickEvictionCandidate,
  type EvictionCandidate,
} from './boardCapacity.js';

const NOW = new Date('2026-11-13T12:00:00.000Z');
const OLD = new Date('2026-11-01T00:00:00.000Z');

function candidate(id: string, extra: Partial<EvictionCandidate> = {}): EvictionCandidate {
  return {
    id,
    title: `板 ${id}`,
    pinnedAt: null,
    openedCount: 0,
    lastOpenedAt: null,
    createdAt: OLD,
    lastEditedAt: OLD,
    ...extra,
  };
}

/** 满容量（12 块）默认板，把指定 id 的字段覆盖掉 */
function full(overrides: Record<string, Partial<EvictionCandidate>> = {}): EvictionCandidate[] {
  return Array.from({ length: BOARD_CAPACITY }, (_, index) => {
    const id = `b${String(index).padStart(2, '0')}`;
    return candidate(id, overrides[id]);
  });
}

describe('pickEvictionCandidate', () => {
  it('容量边界 0 / 1 / 11 块都不淘汰，12 块才开始挑', () => {
    expect(pickEvictionCandidate([], { now: NOW })).toBeNull();
    expect(pickEvictionCandidate(full().slice(0, 1), { now: NOW })).toBeNull();
    expect(pickEvictionCandidate(full().slice(0, BOARD_CAPACITY - 1), { now: NOW })).toBeNull();
    expect(pickEvictionCandidate(full(), { now: NOW })?.id).toBe('b00');
  });

  it('未满 12 块时不淘汰', () => {
    expect(pickEvictionCandidate(full().slice(0, BOARD_CAPACITY - 1), { now: NOW })).toBeNull();
  });

  it('按打开次数升序挑第一块', () => {
    const rows = full().map((row) => ({ ...row, openedCount: 5 }));
    rows[3] = { ...rows[3]!, openedCount: 9 };
    rows[7] = { ...rows[7]!, openedCount: 1 };
    rows[2] = { ...rows[2]!, openedCount: 4 };
    expect(pickEvictionCandidate(rows, { now: NOW })?.id).toBe('b07');
  });

  it('打开次数相同按创建时间升序，再按 id 兜底', () => {
    const rows = full();
    const newer = new Date('2026-11-05T00:00:00.000Z');
    const older = new Date('2026-10-01T00:00:00.000Z');
    rows[0] = { ...rows[0]!, createdAt: newer };
    rows[1] = { ...rows[1]!, createdAt: older };
    rows[2] = { ...rows[2]!, createdAt: older };
    expect(pickEvictionCandidate(rows, { now: NOW })?.id).toBe('b01');
    expect(pickEvictionCandidate([...rows].reverse(), { now: NOW })?.id).toBe('b01');
  });

  it('置顶的板不参与淘汰', () => {
    const rows = full();
    rows[0] = { ...rows[0]!, openedCount: 0, pinnedAt: new Date('2026-10-01T00:00:00.000Z') };
    rows[1] = { ...rows[1]!, openedCount: 100 };
    expect(pickEvictionCandidate(rows, { now: NOW })?.id).toBe('b02');
  });

  it('刚创建、刚编辑、刚打开的板都不参与', () => {
    const rows = full();
    const recent = new Date(NOW.getTime() - 60_000);
    rows[0] = { ...rows[0]!, createdAt: recent };
    rows[1] = { ...rows[1]!, lastEditedAt: recent };
    rows[2] = { ...rows[2]!, lastOpenedAt: recent };
    rows[3] = { ...rows[3]!, openedCount: 7 };
    expect(pickEvictionCandidate(rows, { now: NOW })?.id).toBe('b04');
  });

  it('12 块全被保护时返回 null（不误删）', () => {
    const recent = new Date(NOW.getTime() - 60_000);
    const rows = full().map((row) => ({ ...row, lastEditedAt: recent }));
    expect(pickEvictionCandidate(rows, { now: NOW })).toBeNull();
    expect(listEvictionCandidates(rows, { now: NOW })).toEqual([]);
  });

  it('游客本地置顶的板按 pinnedIds 排除', () => {
    const rows = full().map((row) => ({ ...row, openedCount: 5 }));
    rows[0] = { ...rows[0]!, openedCount: 0 };
    rows[1] = { ...rows[1]!, openedCount: 2 };
    const picked = pickEvictionCandidate(rows, { now: NOW, pinnedIds: new Set(['b00']) });
    expect(picked?.id).toBe('b01');
  });

  it('审计口径文案固定，便于事后复核', () => {
    expect(EVICTION_POLICY).toBe('opened_count asc, created_at asc, id asc');
  });

  it('容量是共享常量里的 12（全仓唯一来源）', () => {
    expect(BOARD_CAPACITY).toBe(12);
  });
});

describe('listEvictionCandidates（恢复时的替换候选）', () => {
  it('按打开次数 → 创建时间 → id 排好，供弹窗直接展示', () => {
    const rows = full().map((row) => ({ ...row, openedCount: 5 }));
    rows[4] = { ...rows[4]!, openedCount: 0 };
    rows[9] = { ...rows[9]!, openedCount: 0 };
    rows[9] = { ...rows[9]!, createdAt: new Date('2026-10-02T00:00:00.000Z') };
    const ids = listEvictionCandidates(rows, { now: NOW }).map((row) => row.id);
    expect(ids.slice(0, 2)).toEqual(['b09', 'b04']);
    expect(ids).toHaveLength(BOARD_CAPACITY);
  });

  it('置顶与 10 分钟内动过的板不进入候选', () => {
    const recent = new Date(NOW.getTime() - 60_000);
    const rows = full();
    rows[0] = { ...rows[0]!, pinnedAt: new Date('2026-10-01T00:00:00.000Z') };
    rows[1] = { ...rows[1]!, lastEditedAt: recent };
    const ids = listEvictionCandidates(rows, { now: NOW }).map((row) => row.id);
    expect(ids).not.toContain('b00');
    expect(ids).not.toContain('b01');
    expect(ids).toHaveLength(BOARD_CAPACITY - 2);
  });

  it('单块判定与列表口径一致', () => {
    expect(isEvictionEligible(candidate('b00'), { now: NOW })).toBe(true);
    expect(isEvictionEligible(candidate('b00', { pinnedAt: OLD }), { now: NOW })).toBe(false);
    expect(isEvictionEligible(candidate('b00'), { now: NOW, pinnedIds: new Set(['b00']) })).toBe(false);
  });
});
