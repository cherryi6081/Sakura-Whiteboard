import { describe, expect, it } from 'vitest';
import {
  THUMB_MAX_EDGE,
  THUMB_MIME,
  THUMB_QUALITY,
  liveElements,
  shouldCapture,
  thumbSignature,
} from './thumbPolicy';

describe('thumbSignature', () => {
  it('空场景与全墓碑场景不产生指纹', () => {
    expect(thumbSignature([])).toBe('');
    expect(thumbSignature([{ id: 'a', isDeleted: true, version: 2, updated: 2 }])).toBe('');
  });

  it('元素版本或 updated 变化都会换指纹', () => {
    const base = [{ id: 'a', version: 3, updated: 100 }];
    expect(thumbSignature(base)).not.toBe(thumbSignature([{ id: 'a', version: 4, updated: 100 }]));
    expect(thumbSignature(base)).not.toBe(thumbSignature([{ id: 'a', version: 3, updated: 101 }]));
    expect(thumbSignature(base)).not.toBe(thumbSignature([...base, { id: 'b', version: 1, updated: 100 }]));
  });

  it('同一场景重复计算稳定', () => {
    const elements = [
      { id: 'a', version: 1, updated: 10 },
      { id: 'b', version: 2, updated: 12 },
    ];
    expect(thumbSignature(elements)).toBe(thumbSignature(elements));
  });
});

describe('shouldCapture', () => {
  it('没有快照时拍，指纹一致时跳过', () => {
    expect(shouldCapture(null, '2:3:10')).toBe(true);
    expect(shouldCapture({ signature: '2:3:10' }, '2:3:10')).toBe(false);
    expect(shouldCapture({ signature: '2:3:10' }, '2:4:12')).toBe(true);
  });

  it('空板一律不拍', () => {
    expect(shouldCapture(null, '')).toBe(false);
  });
});

describe('快照规格', () => {
  it('最长边 640、WebP q0.8', () => {
    expect(THUMB_MAX_EDGE).toBe(640);
    expect(THUMB_MIME).toBe('image/webp');
    expect(THUMB_QUALITY).toBe(0.8);
  });

  it('liveElements 过滤墓碑', () => {
    expect(liveElements([{ id: 'a' }, { id: 'b', isDeleted: true }])).toHaveLength(1);
  });
});
