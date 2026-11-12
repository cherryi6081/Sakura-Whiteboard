/**
 * 空间角色与动作矩阵（设计稿「我的白板 · 团队空间」§05）。
 *
 * 前后端共用同一份判定：前端用它决定「不展示做不到的事」，服务端用它拒绝越权请求。
 * 两处必须同时存在——只做前端是体验，只做后端是会把按钮留在那里让用户反复点。
 *
 * 注意「删除白板」拆成两条：空间所有者可删任意板，编辑者只能删自己创建的板。
 * 这条差异不体现在 role 上，而是由调用方再比对一次 `boards.owner_id`。
 */

export const SPACE_ROLES = ['owner', 'editor', 'viewer'] as const;
export type SpaceRole = (typeof SPACE_ROLES)[number];

export const SPACE_KINDS = ['personal', 'team'] as const;
export type SpaceKind = (typeof SPACE_KINDS)[number];

export const SPACE_ACTIONS = [
  'browse',
  'createBoard',
  'editBoard',
  'pinBoard',
  'reorderBoard',
  'deleteAnyBoard',
  'deleteOwnBoard',
  'invite',
  'manageMembers',
  'manageSpace',
  'copyToPersonal',
  'requestEdit',
] as const;
export type SpaceAction = (typeof SPACE_ACTIONS)[number];

/** 允许该动作的角色；未列出的角色一律拒绝。 */
const ALLOWED: Record<SpaceAction, readonly SpaceRole[]> = {
  browse: ['owner', 'editor', 'viewer'],
  createBoard: ['owner', 'editor'],
  editBoard: ['owner', 'editor'],
  pinBoard: ['owner', 'editor'],
  reorderBoard: ['owner', 'editor'],
  deleteAnyBoard: ['owner'],
  deleteOwnBoard: ['owner', 'editor'],
  invite: ['owner'],
  manageMembers: ['owner'],
  manageSpace: ['owner'],
  // 只读成员的「出口」：浏览与复制到个人空间仍然可用
  copyToPersonal: ['owner', 'editor', 'viewer'],
  requestEdit: ['viewer'],
};

export function isSpaceRole(value: unknown): value is SpaceRole {
  return value === 'owner' || value === 'editor' || value === 'viewer';
}

export function can(role: SpaceRole | string | null | undefined, action: SpaceAction): boolean {
  if (!isSpaceRole(role)) return false;
  return ALLOWED[action].includes(role);
}

export type SpaceSummary = {
  id: string;
  kind: SpaceKind;
  name: string;
  role: SpaceRole;
  memberCount: number;
  boardCount: number;
};
