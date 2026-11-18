import { describe, expect, it } from 'vitest';
import { collectReferencedAssetIds, defaultCopyTitle, remapElementData } from './boardCopyPlan.js';

/**
 * 复制的纯函数部分：文件引用收集与重映射。
 * 资产字节复制 / 落库需要数据库，不在这里覆盖。
 */

describe('collectReferencedAssetIds', () => {
  it('收集 fileId 与 customData.assetId，并按出现顺序去重', () => {
    const ids = collectReferencedAssetIds([
      { data: { fileId: 'a' } },
      { data: { fileId: 'a', customData: { assetId: 'a' } } },
      { data: { customData: { assetId: 'b' } } },
      { data: { fileId: 'c' } },
      { data: { text: '没有引用' } },
    ]);
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  it('忽略非字符串 / 空串引用', () => {
    expect(
      collectReferencedAssetIds([
        { data: { fileId: '' } },
        { data: { fileId: 42 } },
        { data: { customData: { assetId: null } } },
      ]),
    ).toEqual([]);
  });
});

describe('remapElementData', () => {
  it('同时改写 fileId 与 customData.assetId', () => {
    const next = remapElementData(
      { fileId: 'old', customData: { assetId: 'old', keep: true }, x: 1 },
      new Map([['old', 'new']]),
    );
    expect(next).toEqual({ fileId: 'new', customData: { assetId: 'new', keep: true }, x: 1 });
  });

  it('不引用资产时原样返回', () => {
    const data = { text: 'hello' };
    expect(remapElementData(data, new Map())).toBe(data);
  });

  it('引用的资产缺失时返回 null（调用方跳过该元素）', () => {
    expect(remapElementData({ fileId: 'missing' }, new Map([['other', 'new']]))).toBeNull();
  });
});

describe('defaultCopyTitle', () => {
  it('追加“的副本”', () => {
    expect(defaultCopyTitle('季度规划')).toBe('季度规划 的副本');
  });

  it('超长标题按 80 字上限截断后再拼后缀', () => {
    const title = defaultCopyTitle('长'.repeat(100));
    expect(title.length).toBe(80);
    expect(title.endsWith(' 的副本')).toBe(true);
  });
});
