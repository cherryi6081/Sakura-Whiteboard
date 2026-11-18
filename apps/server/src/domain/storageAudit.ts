import { classifyStorageKey, type StorageKeyKind } from './storageKeys.js';

/**
 * 跨存储一致性校验的纯计算部分（不连接数据库 / 不访问存储，便于单测）。
 *
 * 对账口径只有两类，绝不自动删除或修复：
 * 1. `missingObjects`：数据库里有引用，但存储里找不到对象（读图/下载会 503/404）；
 * 2. `orphanObjects`：存储里有对象，但没有任何库引用（多为硬删白板、
 *    覆盖上传失败或历史迁移残留，是 `storage:audit` 报告出来让人判断的）。
 *
 * 另附 `sizeMismatch`：资产行记录字节数与对象实际大小不一致（可能截断/写坏），
 * 属于告警信号，同样只报告。
 */

export type ListedObject = { key: string; size: number };

export type ReferencedObject = {
  key: string;
  kind: StorageKeyKind;
  /** 资产行记录的大小；缩略图/头像没有库内大小，传 null */
  sizeBytes?: number | null;
};

export type AuditEntry = {
  key: string;
  kind: StorageKeyKind | 'unknown';
  expectedSize?: number | null;
  actualSize?: number | null;
};

export type StorageAuditReport = {
  driver: string;
  generatedAt: string;
  referenced: { total: number; byKind: Record<StorageKeyKind, number> };
  stored: { total: number; bytes: number };
  /** 库里有引用、对象缺失 */
  missingObjects: {
    total: number;
    byKind: Record<StorageKeyKind, number>;
    sample: AuditEntry[];
  };
  /** 对象存在、库里没人引用 */
  orphanObjects: {
    total: number;
    byKind: Record<StorageKeyKind | 'unknown', number>;
    bytes: number;
    sample: AuditEntry[];
  };
  /** 资产行大小与对象实际大小不一致 */
  sizeMismatch: { total: number; sample: AuditEntry[] };
};

const emptyKindCounts = (): Record<StorageKeyKind, number> => ({ asset: 0, thumbnail: 0, avatar: 0 });
const emptyOrphanKindCounts = (): Record<StorageKeyKind | 'unknown', number> => ({
  asset: 0,
  thumbnail: 0,
  avatar: 0,
  unknown: 0,
});

const AVATAR_URL_PREFIX = '/api/avatars/';

/** 把 `users.avatar_url` 反解成存储 key；外链（GitHub 头像）返回 null。 */
export function avatarKeyOfUrl(url: string): string | null {
  if (!url.startsWith(AVATAR_URL_PREFIX)) return null;
  const key = `avatars/${url.slice(AVATAR_URL_PREFIX.length)}`;
  return classifyStorageKey(key) === 'avatar' ? key : null;
}

export function buildStorageAudit(input: {
  driver: string;
  referenced: readonly ReferencedObject[];
  listed: readonly ListedObject[];
  sampleLimit?: number;
  now?: Date;
}): StorageAuditReport {
  const sampleLimit = Math.max(1, input.sampleLimit ?? 50);
  const referenced = new Map<string, ReferencedObject>();
  for (const item of input.referenced) {
    if (!referenced.has(item.key)) referenced.set(item.key, { ...item });
  }
  const stored = new Map<string, ListedObject>();
  for (const item of input.listed) stored.set(item.key, item);

  const referencedByKind = emptyKindCounts();
  for (const item of referenced.values()) referencedByKind[item.kind] += 1;

  const missingByKind = emptyKindCounts();
  const missingSample: AuditEntry[] = [];
  let missingTotal = 0;
  const sizeMismatchSample: AuditEntry[] = [];
  let sizeMismatchTotal = 0;

  for (const item of referenced.values()) {
    const object = stored.get(item.key);
    if (!object) {
      missingTotal += 1;
      missingByKind[item.kind] += 1;
      if (missingSample.length < sampleLimit) missingSample.push({ key: item.key, kind: item.kind });
      continue;
    }
    if (item.sizeBytes != null && item.sizeBytes !== object.size) {
      sizeMismatchTotal += 1;
      if (sizeMismatchSample.length < sampleLimit) {
        sizeMismatchSample.push({
          key: item.key,
          kind: item.kind,
          expectedSize: item.sizeBytes,
          actualSize: object.size,
        });
      }
    }
  }

  const orphanByKind = emptyOrphanKindCounts();
  const orphanSample: AuditEntry[] = [];
  let orphanTotal = 0;
  let orphanBytes = 0;
  for (const object of stored.values()) {
    if (referenced.has(object.key)) continue;
    orphanTotal += 1;
    orphanBytes += object.size;
    const kind = classifyStorageKey(object.key) ?? 'unknown';
    orphanByKind[kind] += 1;
    if (orphanSample.length < sampleLimit) {
      orphanSample.push({ key: object.key, kind, actualSize: object.size });
    }
  }

  let storedBytes = 0;
  for (const object of stored.values()) storedBytes += object.size;

  return {
    driver: input.driver,
    generatedAt: (input.now ?? new Date()).toISOString(),
    referenced: { total: referenced.size, byKind: referencedByKind },
    stored: { total: stored.size, bytes: storedBytes },
    missingObjects: { total: missingTotal, byKind: missingByKind, sample: missingSample },
    orphanObjects: { total: orphanTotal, byKind: orphanByKind, bytes: orphanBytes, sample: orphanSample },
    sizeMismatch: { total: sizeMismatchTotal, sample: sizeMismatchSample },
  };
}
