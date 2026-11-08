/**
 * `join` 时的角色推导（M2-C4 的只读模式）。
 *
 * 当前没有会话/OAuth/分享 token 校验，因此 `viewOnly` 完全由客户端在 `join`
 * 载荷里自报。它只能把 `editor` 主动降为 `viewer`，**不能**把 `viewer` 提权；
 * 服务端仍然以推导结果做唯一的写权限判断（`op:submit` 只放行 editor）。
 *
 * 可信度边界：自报 `viewOnly` 只防误操作，不防恶意客户端——恶意连接不声明
 * `viewOnly` 就能拿到 editor。真正的分享 token / 会话鉴权待 M1/M5 补齐。
 */
export type JoinShareMode = 'private' | 'link_read' | 'link_edit';
export type JoinRole = 'editor' | 'viewer';

export function resolveJoinRole(shareMode: JoinShareMode, viewOnly = false): JoinRole | 'forbidden' {
  if (shareMode === 'private') return 'forbidden';
  if (shareMode === 'link_read') return 'viewer';
  return viewOnly ? 'viewer' : 'editor';
}
