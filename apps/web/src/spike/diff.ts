/**
 * M2 spike ②：onChange 全量数组 -> 元素级 op 的候选 diff 实现。
 * 只用于验证稳定性，不接入协作/网络。
 */

export type ElementSnapshot = {
  id: string;
  version: number;
  versionNonce: number;
  isDeleted: boolean;
};

export type ElementOp =
  | { kind: "upsert"; id: string; baseVersion: number | null; version: number }
  | { kind: "delete"; id: string; baseVersion: number; version: number };

type MinimalElement = {
  id: string;
  version: number;
  versionNonce: number;
  isDeleted: boolean;
};

export function snapshotOf(el: MinimalElement): ElementSnapshot {
  return {
    id: el.id,
    version: el.version,
    versionNonce: el.versionNonce,
    isDeleted: el.isDeleted,
  };
}

export function snapshotMap(elements: readonly MinimalElement[]): Map<string, ElementSnapshot> {
  const map = new Map<string, ElementSnapshot>();
  for (const el of elements) map.set(el.id, snapshotOf(el));
  return map;
}

export function diffElements(
  prev: Map<string, ElementSnapshot>,
  next: readonly MinimalElement[],
): ElementOp[] {
  const ops: ElementOp[] = [];
  const seen = new Set<string>();

  for (const el of next) {
    seen.add(el.id);
    const old = prev.get(el.id);
    if (!old) {
      ops.push(
        el.isDeleted
          ? { kind: "delete", id: el.id, baseVersion: el.version - 1, version: el.version }
          : { kind: "upsert", id: el.id, baseVersion: null, version: el.version },
      );
      continue;
    }
    if (old.version !== el.version || old.versionNonce !== el.versionNonce || old.isDeleted !== el.isDeleted) {
      ops.push(
        el.isDeleted
          ? { kind: "delete", id: el.id, baseVersion: el.version - 1, version: el.version }
          : { kind: "upsert", id: el.id, baseVersion: old.version, version: el.version },
      );
    }
  }

  for (const [id, old] of prev) {
    if (!seen.has(id) && !old.isDeleted) {
      ops.push({ kind: "delete", id, baseVersion: old.version, version: old.version + 1 });
    }
  }

  return ops;
}
