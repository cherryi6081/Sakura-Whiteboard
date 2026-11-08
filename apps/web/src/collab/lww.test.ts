import { describe, expect, it } from 'vitest';
import { decideRemoteApply } from './lww';

describe('decideRemoteApply（客户端回放）', () => {
  it('本地没有该元素时直接应用', () => {
    expect(decideRemoteApply(null, { version: 1, versionNonce: 10 })).toBe('apply');
  });

  it('远端 version 更大时应用', () => {
    expect(decideRemoteApply({ version: 2, versionNonce: 10 }, { version: 3, versionNonce: 20 })).toBe('apply');
  });

  it('远端 version 更小（本地有未确认更新）时忽略', () => {
    expect(decideRemoteApply({ version: 4, versionNonce: 10 }, { version: 3, versionNonce: 1 })).toBe('ignore');
  });

  it('version 相同比 versionNonce：小者胜', () => {
    expect(decideRemoteApply({ version: 3, versionNonce: 30 }, { version: 3, versionNonce: 20 })).toBe('apply');
    expect(decideRemoteApply({ version: 3, versionNonce: 20 }, { version: 3, versionNonce: 30 })).toBe('ignore');
  });

  it('完全相同视为平局，不覆盖本地', () => {
    expect(decideRemoteApply({ version: 3, versionNonce: 20 }, { version: 3, versionNonce: 20 })).toBe('ignore');
  });
});
