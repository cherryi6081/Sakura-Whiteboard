/**
 * M2-C4：客户端侧回放远端 op 的 LWW 判定。
 *
 * 必须与服务端 `apps/server/src/domain/lww.ts` 保持同一语义（文档 §2.4）：
 * - `version` 大者胜；
 * - 相等时 `versionNonce` 小者胜；
 * - 相同则视为平局，不改本地。
 *
 * 客户端比服务端多一层"本地乐观值"：如果本地元素版本比远端广播更高，
 * 说明本地还有尚未被服务端确认的更新，此时忽略远端，等自己的 op 走 LWW。
 */
export type LwwState = {
  version: number;
  versionNonce: number;
};

export type RemoteDecision = 'apply' | 'ignore';

export function decideRemoteApply(local: LwwState | null, incoming: LwwState): RemoteDecision {
  if (!local) return 'apply';

  if (incoming.version > local.version) return 'apply';
  if (incoming.version < local.version) return 'ignore';

  if (incoming.versionNonce < local.versionNonce) return 'apply';
  // 非更小（更大或完全相同）都不该覆盖本地
  return 'ignore';
}
