/**
 * 元素级 LWW 裁决（文档 §2.4）。
 *
 * 规则：
 * - `version` 大者胜；
 * - 相等时 `versionNonce` **小者胜**；
 * - version 更小 = 落后（stale），保留库里旧值；
 * - 墓碑（`is_deleted=true`）与普通元素使用同一套比较，删除也参与 LWW。
 *
 * 本模块是纯函数，不碰 DB/Redis，便于单测覆盖所有分支。
 */

export type LwwCandidate = {
  version: number;
  versionNonce: number;
};

export type ExistingElementState = LwwCandidate & {
  isDeleted: boolean;
};

export type LwwReason = 'insert' | 'newer-version' | 'smaller-nonce' | 'older-version' | 'larger-nonce' | 'tie';

export type LwwVerdict = {
  /** 是否用入站值覆盖库里元素 */
  apply: boolean;
  /** 是否需要告知客户端"你落后了，重取最终态" */
  stale: boolean;
  reason: LwwReason;
};

export function decideLww(existing: ExistingElementState | null, incoming: LwwCandidate): LwwVerdict {
  if (!existing) return { apply: true, stale: false, reason: 'insert' };

  if (incoming.version > existing.version) {
    return { apply: true, stale: false, reason: 'newer-version' };
  }

  if (incoming.version < existing.version) {
    return { apply: false, stale: true, reason: 'older-version' };
  }

  if (incoming.versionNonce < existing.versionNonce) {
    return { apply: true, stale: false, reason: 'smaller-nonce' };
  }

  if (incoming.versionNonce > existing.versionNonce) {
    return { apply: false, stale: true, reason: 'larger-nonce' };
  }

  // 完全相同：不改库、也不提示 stale（客户端本地已是同一状态）
  return { apply: false, stale: false, reason: 'tie' };
}
