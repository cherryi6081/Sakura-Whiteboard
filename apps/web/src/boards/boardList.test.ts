import { describe, expect, it } from 'vitest';
import {
  BOARDS_PAGE_SIZE,
  hasMoreBoards,
  isPinned,
  sortBoards,
  visibleBoards,
  type PinnableBoard,
} from './boardList';

const board = (id: string, lastEditedAt: string, extra: Partial<PinnableBoard> = {}): PinnableBoard => ({
  id,
  lastEditedAt,
  ...extra,
});

describe('sortBoards', () => {
  it('置顶优先，其次最近打开倒序', () => {
    const sorted = sortBoards([
      board('a', '2026-11-01T00:00:00.000Z'),
      board('b', '2026-11-09T00:00:00.000Z', { pinnedAt: '2026-10-01T00:00:00.000Z' }),
      board('c', '2026-11-10T00:00:00.000Z'),
      board('d', '2026-11-02T00:00:00.000Z', { pinned: true }),
    ]);
    expect(sorted.map((item) => item.id)).toEqual(['b', 'd', 'c', 'a']);
  });

  it('时间相同按 id 稳定排序，不依赖原数组顺序', () => {
    const time = '2026-11-10T00:00:00.000Z';
    const first = sortBoards([board('z', time), board('a', time)]).map((item) => item.id);
    const second = sortBoards([board('a', time), board('z', time)]).map((item) => item.id);
    expect(first).toEqual(['a', 'z']);
    expect(second).toEqual(['a', 'z']);
  });

  it('非法时间不参与比较，仍能落在置顶分组之后', () => {
    const sorted = sortBoards([board('bad', 'not-a-date'), board('ok', '2026-11-10T00:00:00.000Z')]);
    expect(sorted[0]?.id).toBe('ok');
  });
});

describe('isPinned', () => {
  it('服务端时间戳与本地布尔字段都算置顶', () => {
    expect(isPinned(board('a', '', { pinnedAt: '2026-11-01T00:00:00.000Z' }))).toBe(true);
    expect(isPinned(board('b', '', { pinned: true }))).toBe(true);
    expect(isPinned(board('c', '', { pinnedAt: null, pinned: false }))).toBe(false);
  });
});

describe('分页', () => {
  const items = Array.from({ length: 14 }, (_, index) => index);

  it('每页 6 张，逐页累加', () => {
    expect(BOARDS_PAGE_SIZE).toBe(6);
    expect(visibleBoards(items, 1)).toHaveLength(6);
    expect(visibleBoards(items, 2)).toHaveLength(12);
    expect(visibleBoards(items, 3)).toHaveLength(14);
  });

  it('页码非法时退回第一页', () => {
    expect(visibleBoards(items, 0)).toHaveLength(6);
    expect(visibleBoards(items, Number.NaN)).toHaveLength(6);
  });

  it('加载更多按钮只在还有剩余时出现', () => {
    expect(hasMoreBoards(14, 1)).toBe(true);
    expect(hasMoreBoards(14, 2)).toBe(true);
    expect(hasMoreBoards(14, 3)).toBe(false);
    expect(hasMoreBoards(6, 1)).toBe(false);
  });
});
