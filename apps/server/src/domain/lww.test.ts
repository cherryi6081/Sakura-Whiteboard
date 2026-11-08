import { describe, expect, it } from 'vitest';
import { decideLww } from './lww.js';

describe('decideLww', () => {
  it('库里没有该元素 -> 直接插入', () => {
    expect(decideLww(null, { version: 1, versionNonce: 5 })).toEqual({ apply: true, stale: false, reason: 'insert' });
  });

  it('version 更大 -> 覆盖', () => {
    expect(decideLww({ version: 3, versionNonce: 9, isDeleted: false }, { version: 4, versionNonce: 100 })).toEqual({
      apply: true,
      stale: false,
      reason: 'newer-version',
    });
  });

  it('version 更小 -> 拒绝并判 stale', () => {
    expect(decideLww({ version: 5, versionNonce: 1, isDeleted: false }, { version: 3, versionNonce: 2 })).toEqual({
      apply: false,
      stale: true,
      reason: 'older-version',
    });
  });

  it('version 相同、versionNonce 更小 -> 覆盖（小者胜）', () => {
    expect(decideLww({ version: 5, versionNonce: 20, isDeleted: false }, { version: 5, versionNonce: 11 })).toEqual({
      apply: true,
      stale: false,
      reason: 'smaller-nonce',
    });
  });

  it('version 相同、versionNonce 更大 -> 拒绝并判 stale', () => {
    expect(decideLww({ version: 5, versionNonce: 11, isDeleted: false }, { version: 5, versionNonce: 20 })).toEqual({
      apply: false,
      stale: true,
      reason: 'larger-nonce',
    });
  });

  it('version 与 versionNonce 完全相同 -> 不改库、不提示 stale', () => {
    expect(decideLww({ version: 5, versionNonce: 11, isDeleted: false }, { version: 5, versionNonce: 11 })).toEqual({
      apply: false,
      stale: false,
      reason: 'tie',
    });
  });

  it('墓碑参与比较：删除版本更大 -> 覆盖为墓碑', () => {
    expect(decideLww({ version: 2, versionNonce: 3, isDeleted: false }, { version: 3, versionNonce: 8 })).toEqual({
      apply: true,
      stale: false,
      reason: 'newer-version',
    });
  });

  it('墓碑参与比较：旧 upsert 不能复活墓碑', () => {
    expect(decideLww({ version: 4, versionNonce: 6, isDeleted: true }, { version: 3, versionNonce: 2 })).toEqual({
      apply: false,
      stale: true,
      reason: 'older-version',
    });
  });

  it('墓碑参与比较：同版本靠 nonce 小者改写墓碑状态', () => {
    expect(decideLww({ version: 4, versionNonce: 6, isDeleted: true }, { version: 4, versionNonce: 5 })).toEqual({
      apply: true,
      stale: false,
      reason: 'smaller-nonce',
    });
  });
});
