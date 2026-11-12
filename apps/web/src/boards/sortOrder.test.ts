import { describe, expect, it } from 'vitest';
import { dropIndex, moveItem, neighborsAt, splitGroups } from './sortOrder';

const card = (id: string, pinned = false) => ({ id, pinned });

describe('splitGroups', () => {
  it('置顶组与普通组按入参顺序分开，互不交错', () => {
    const { pinned, others } = splitGroups([card('a'), card('b', true), card('c'), card('d', true)]);
    expect(pinned.map((item) => item.id)).toEqual(['b', 'd']);
    expect(others.map((item) => item.id)).toEqual(['a', 'c']);
  });

  it('没有置顶时整表就是普通组', () => {
    const { pinned, others } = splitGroups([card('a'), card('b')]);
    expect(pinned).toHaveLength(0);
    expect(others).toHaveLength(2);
  });
});

describe('moveItem', () => {
  const list = ['a', 'b', 'c', 'd'];

  it('向后移：源位置移除后再插入目标下标', () => {
    expect(moveItem(list, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('向前移', () => {
    expect(moveItem(list, 3, 1)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('目标与源相同或越界时原样返回副本', () => {
    expect(moveItem(list, 1, 1)).toEqual(list);
    expect(moveItem(list, -1, 2)).toEqual(list);
    expect(moveItem(list, 4, 0)).toEqual(list);
  });

  it('移到组尾', () => {
    expect(moveItem(list, 1, 3)).toEqual(['a', 'c', 'd', 'b']);
  });
});

describe('neighborsAt', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('组首只有右侧邻居', () => {
    expect(neighborsAt(list, 0)).toEqual({ beforeId: null, afterId: 'b' });
  });

  it('组尾只有左侧邻居', () => {
    expect(neighborsAt(list, 2)).toEqual({ beforeId: 'b', afterId: null });
  });

  it('中间两侧都有', () => {
    expect(neighborsAt(list, 1)).toEqual({ beforeId: 'a', afterId: 'c' });
  });
});

describe('dropIndex', () => {
  const rects = [
    { id: 'a', left: 0, top: 0, width: 100, height: 100 },
    { id: 'b', left: 120, top: 0, width: 100, height: 100 },
    { id: 'c', left: 240, top: 0, width: 100, height: 100 },
  ];

  it('跨过中线才计一位，落点只取整数槽位', () => {
    expect(dropIndex(rects, { x: 40, y: 50 }, 'a', true)).toBe(0);
    expect(dropIndex(rects, { x: 175, y: 50 }, 'a', true)).toBe(1);
    expect(dropIndex(rects, { x: 300, y: 50 }, 'a', true)).toBe(2);
  });

  it('排除源卡自身，下标是移除源卡后的位置', () => {
    expect(dropIndex(rects, { x: 200, y: 50 }, 'b', true)).toBe(1);
    expect(dropIndex(rects, { x: 300, y: 50 }, 'b', true)).toBe(2);
  });

  it('单列时按 Y 轴判定', () => {
    const vertical = [
      { id: 'a', left: 0, top: 0, width: 300, height: 100 },
      { id: 'b', left: 0, top: 120, width: 300, height: 100 },
    ];
    expect(dropIndex(vertical, { x: 10, y: 180 }, 'a', false)).toBe(1);
    expect(dropIndex(vertical, { x: 10, y: 40 }, 'a', false)).toBe(0);
  });
});
