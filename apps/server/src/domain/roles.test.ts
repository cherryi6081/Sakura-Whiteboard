import { describe, expect, it } from 'vitest';
import { resolveJoinRole } from './roles.js';

describe('resolveJoinRole', () => {
  it('link_edit 默认是 editor', () => {
    expect(resolveJoinRole('link_edit')).toBe('editor');
  });

  it('link_edit + 客户端声明 viewOnly 降级为 viewer', () => {
    expect(resolveJoinRole('link_edit', true)).toBe('viewer');
  });

  it('link_read 无论是否声明都是 viewer', () => {
    expect(resolveJoinRole('link_read')).toBe('viewer');
    expect(resolveJoinRole('link_read', false)).toBe('viewer');
    expect(resolveJoinRole('link_read', true)).toBe('viewer');
  });

  it('private 一律禁止，即使声明 viewOnly', () => {
    expect(resolveJoinRole('private')).toBe('forbidden');
    expect(resolveJoinRole('private', true)).toBe('forbidden');
  });
});
