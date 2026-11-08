import { z } from 'zod';
import { LIMITS } from '@whiteboard/shared';

/**
 * M2-C5 补拉页的纯计算部分（不碰 Express / PG，便于单测）。
 *
 * 约定与设计差异见开发文档 §7.2.3：
 * - 查询参数是 `since`（**不含**该 seq，即返回 `seq > since` 的行），设计文档早期写的是 `afterSeq`；
 * - 落后超过 `LIMITS.resyncThreshold` 时直接要求客户端走快照重载，不再分页补拉。
 */

export const boardIdSchema = z.string().regex(LIMITS.boardIdPattern);

export const opsQuerySchema = z.object({
  since: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(LIMITS.opsPageMax).default(LIMITS.opsPageMax),
});

export type OpsQuery = z.infer<typeof opsQuerySchema>;

/** 本地 seq 与服务端差距过大时，分页补拉无意义，直接整板重载。 */
export function needsResync(since: number, lastSeq: number): boolean {
  return lastSeq - since > LIMITS.resyncThreshold;
}

/**
 * 根据"多取一条"的结果判断是否还有下一页。
 *
 * @param rowCount 实际取回的行数（调用方应取 `limit + 1` 条）
 * @param lastRowSeq 本页最后一条（调用方已裁剪到 `limit`）的 seq
 */
export function paginatePage(input: {
  since: number;
  limit: number;
  rowCount: number;
  lastRowSeq: number | null;
}): { hasMore: boolean; nextSince: number } {
  const { since, limit, rowCount, lastRowSeq } = input;
  const hasMore = rowCount > limit;
  const nextSince = lastRowSeq !== null && lastRowSeq > since ? lastRowSeq : since;
  return { hasMore, nextSince };
}
