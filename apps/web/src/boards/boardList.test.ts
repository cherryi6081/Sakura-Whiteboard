import { describe, expect, it } from 'vitest';
import { BOARD_CAPACITY } from '@whiteboard/shared';
import { BOARDS_CAPACITY, isPinned, matchesBoardTitle, sortBoards, type PinnableBoard } from './boardList';

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

  it('手动模式下组内按 rank 升序，没 rank 的排在后面', () => {
    const sorted = sortBoards(
      [
        board('a', '2026-11-10T00:00:00.000Z', { rank: 3072 }),
        board('b', '2026-11-01T00:00:00.000Z', { rank: 1024 }),
        board('c', '2026-11-05T00:00:00.000Z', { rank: 2048 }),
        board('d', '2026-11-11T00:00:00.000Z'),
      ],
      'manual',
    );
    expect(sorted.map((item) => item.id)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('手动模式也不跨组：置顶区仍整体在前', () => {
    const sorted = sortBoards(
      [
        board('a', '2026-11-10T00:00:00.000Z', { rank: 1024 }),
        board('p', '2026-10-01T00:00:00.000Z', { pinnedAt: '2026-10-01T00:00:00.000Z', rank: 2048 }),
      ],
      'manual',
    );
    expect(sorted.map((item) => item.id)).toEqual(['p', 'a']);
  });
});

describe('matchesBoardTitle', () => {
  it('空查询（含纯空格）命中所有白板', () => {
    expect(matchesBoardTitle('产品路线图', '')).toBe(true);
    expect(matchesBoardTitle('产品路线图', '   ')).toBe(true);
  });

  it('大小写不敏感', () => {
    expect(matchesBoardTitle('Q4 Roadmap', 'roadmap')).toBe(true);
    expect(matchesBoardTitle('q4 roadmap', 'ROADMAP')).toBe(true);
  });

  it('子串命中，且两边都先 trim', () => {
    expect(matchesBoardTitle('  团队周会纪要  ', '周会')).toBe(true);
    expect(matchesBoardTitle('设计稿 v2', ' 计稿 v ')).toBe(true);
  });

  it('不命中时返回 false', () => {
    expect(matchesBoardTitle('产品路线图', 'swot')).toBe(false);
  });
});

describe('isPinned', () => {
  it('服务端时间戳与本地布尔字段都算置顶', () => {
    expect(isPinned(board('a', '', { pinnedAt: '2026-11-01T00:00:00.000Z' }))).toBe(true);
    expect(isPinned(board('b', '', { pinned: true }))).toBe(true);
    expect(isPinned(board('c', '', { pinnedAt: null, pinned: false }))).toBe(false);
  });
});

describe('容量', () => {
  it('一页 12 张（4 列 × 3 行），不做翻页，且与共享常量同源', () => {
    expect(BOARDS_CAPACITY).toBe(12);
    expect(BOARDS_CAPACITY).toBe(BOARD_CAPACITY);
  });
});
