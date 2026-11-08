import type { ElementOp, ElementSnapshot } from "@whiteboard/shared";

/**
 * M2-C2：onChange 全量数组 -> 元素级 op。
 *
 * 只负责"上一帧 vs 这一帧"的纯计算与批量合并，不碰网络、不碰渲染、不碰存储；
 * 渲染层通过 `BoardCanvas` 把 `onChange(elements)` 交进来即可。
 */

export type MinimalElement = {
  id: string;
  version: number;
  versionNonce: number;
  isDeleted: boolean;
};

export type DeriveOptions = {
  /** 仅为"元素从数组里消失"合成墓碑版本时使用；测试可注入确定值 */
  nonce?: () => number;
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

const defaultNonce = () => Math.floor(Math.random() * 1_000_000_000);

/**
 * 规则：
 * - 新增 -> `upsert`，`baseVersion = null`
 * - `version` 变大 -> `upsert`，`baseVersion = 旧 version`
 * - 同一 id 且 `isDeleted` 变 true -> `delete`（墓碑，版本由元素自身带）
 * - 从数组里消失且旧帧未删除 -> 合成 `delete`，`version = 旧 version + 1`
 * - 版本/决胜随机数/墓碑标记都没变 -> 不产出（纯交互噪声 0 op）
 */
export function diffElements(
  prev: Map<string, ElementSnapshot>,
  next: readonly MinimalElement[],
  options: DeriveOptions = {},
): ElementOp[] {
  const nonce = options.nonce ?? defaultNonce;
  const ops: ElementOp[] = [];
  const seen = new Set<string>();

  for (const el of next) {
    seen.add(el.id);
    const old = prev.get(el.id);
    if (!old) {
      ops.push(
        el.isDeleted
          ? { kind: "delete", id: el.id, baseVersion: el.version - 1, version: el.version, versionNonce: el.versionNonce }
          : { kind: "upsert", id: el.id, baseVersion: null, version: el.version, versionNonce: el.versionNonce },
      );
      continue;
    }
    if (old.version !== el.version || old.versionNonce !== el.versionNonce || old.isDeleted !== el.isDeleted) {
      ops.push(
        el.isDeleted
          ? { kind: "delete", id: el.id, baseVersion: old.version, version: el.version, versionNonce: el.versionNonce }
          : { kind: "upsert", id: el.id, baseVersion: old.version, version: el.version, versionNonce: el.versionNonce },
      );
    }
  }

  for (const [id, old] of prev) {
    if (!seen.has(id) && !old.isDeleted) {
      ops.push({ kind: "delete", id, baseVersion: old.version, version: old.version + 1, versionNonce: nonce() });
    }
  }

  return ops;
}

/** 有状态封装：内部维护"上一帧"快照，调用方只传当前帧。 */
export function createOpDeriver(options: DeriveOptions = {}) {
  let prev = new Map<string, ElementSnapshot>();

  return {
    reset(elements: readonly MinimalElement[] = []) {
      prev = snapshotMap(elements);
    },
    derive(elements: readonly MinimalElement[]): ElementOp[] {
      const ops = diffElements(prev, elements, options);
      prev = snapshotMap(elements);
      return ops;
    },
  };
}

export type FlushHandler = (ops: ElementOp[]) => void;

/**
 * 50ms 静默 flush + 手动 flush（pointerup/失焦时立即发送）。
 * 同 id 只保留最后一条，避免拖动过程中每帧都排队。
 */
export function createOpBatcher({
  onFlush,
  delayMs = 50,
}: {
  onFlush: FlushHandler;
  delayMs?: number;
}) {
  const pending = new Map<string, ElementOp>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flushNow = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending.size === 0) return;
    const batch = [...pending.values()];
    pending.clear();
    onFlush(batch);
  };

  const schedule = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      flushNow();
    }, delayMs);
  };

  return {
    push(ops: readonly ElementOp[]) {
      if (ops.length === 0) return;
      for (const op of ops) pending.set(op.id, op);
      schedule();
    },
    flushNow,
    pendingCount: () => pending.size,
    dispose() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending.clear();
    },
  };
}
