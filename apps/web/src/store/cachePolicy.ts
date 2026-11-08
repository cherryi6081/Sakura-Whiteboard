import { LIMITS } from '@whiteboard/shared';

/**
 * M2-C5 本地缓存的纯规则：库名、store 名、复合键、TTL 与补拉判定。
 * 放在独立文件是为了能在 Node 里单测（不 import IndexedDB）。
 */

export const CACHE_DB_NAME = 'wb-cache';
export const CACHE_DB_VERSION = 1;

export const CACHE_STORES = {
  /** 元素缓存，主键是复合键 [boardId, elementId]（设计契约 §8.6.4） */
  elements: 'elements',
  /** 待发队列（持久化 outbox），主键自增，按 boardId 建索引 */
  outbox: 'outbox',
  /** 每块板的同步水位（seq）与最近访问时间，用于 TTL 清理 */
  meta: 'meta',
} as const;

export const ELEMENT_KEY_PATH = ['boardId', 'elementId'] as const;

/** 缓存过期时间：7 天未访问即删除（最小清理策略，见开发文档 §8.6.4） */
export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function elementKey(boardId: string, elementId: string): [string, string] {
  return [boardId, elementId];
}

export function isCacheExpired(lastAccessAt: number, now = Date.now(), ttlMs = CACHE_TTL_MS): boolean {
  if (!Number.isFinite(lastAccessAt) || lastAccessAt <= 0) return true;
  return now - lastAccessAt > ttlMs;
}

/**
 * 客户端侧兜底：即使服务端没回 `resync`，本地水位落后超过阈值也走快照重载。
 * 阈值与 shared 的 `LIMITS.resyncThreshold` 保持一致。
 */
export function decideResync(since: number, lastSeq: number, threshold = LIMITS.resyncThreshold): boolean {
  return lastSeq - since > threshold;
}
