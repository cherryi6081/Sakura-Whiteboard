import { describe, expect, it } from 'vitest';
import { can, isSpaceRole, SPACE_ACTIONS } from '@whiteboard/shared';

describe('空间角色矩阵', () => {
  it('只读成员只能浏览、复制到个人空间并申请编辑', () => {
    expect(can('viewer', 'browse')).toBe(true);
    expect(can('viewer', 'copyToPersonal')).toBe(true);
    expect(can('viewer', 'requestEdit')).toBe(true);
    for (const action of ['createBoard', 'editBoard', 'pinBoard', 'reorderBoard', 'deleteOwnBoard', 'invite'] as const) {
      expect(can('viewer', action), action).toBe(false);
    }
  });

  it('编辑者能写，但不能邀请成员、不能删别人的板', () => {
    expect(can('editor', 'createBoard')).toBe(true);
    expect(can('editor', 'deleteOwnBoard')).toBe(true);
    expect(can('editor', 'deleteAnyBoard')).toBe(false);
    expect(can('editor', 'invite')).toBe(false);
    expect(can('editor', 'manageMembers')).toBe(false);
    expect(can('editor', 'manageSpace')).toBe(false);
  });

  it('所有者拥有除「申请编辑」外的全部动作', () => {
    for (const action of SPACE_ACTIONS) {
      if (action === 'requestEdit') continue;
      expect(can('owner', action), action).toBe(true);
    }
    expect(can('owner', 'requestEdit')).toBe(false);
  });

  it('未知角色与空值一律拒绝', () => {
    expect(can(null, 'browse')).toBe(false);
    expect(can('admin', 'browse')).toBe(false);
    expect(isSpaceRole('owner')).toBe(true);
    expect(isSpaceRole('admin')).toBe(false);
  });
});
