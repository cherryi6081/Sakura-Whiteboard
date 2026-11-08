import { ELEMENT_TYPES, type ElementOp, type ElementSnapshot, type ElementType } from "@whiteboard/shared";

/**
 * M2-C2：onChange 全量数组 -> 元素级 op。
 *
 * 只负责"上一帧 vs 这一帧"的纯计算与批量合并，不碰网络、不碰渲染、不碰存储；
 * 渲染层通过 `BoardCanvas` 把 `onChange(elements)` 交进来即可。
 *
 * C3 起 op 需要能直接落库，因此补齐了 `opId`（幂等键）、`type`、`data`、`zindexKey`。
 */

export type MinimalElement = {
  id: string;
  version: number;
  versionNonce: number;
  isDeleted: boolean;
  type?: string;
  /** Excalidraw 0.18 的分数索引；缺失时按数组位置合成 */
  index?: string | number | null;
  [key: string]: unknown;
};

export type DeriveOptions = {
  /** 仅为"元素从数组里消失"合成墓碑版本时使用；测试可注入确定值 */
  nonce?: () => number;
  /** opId 生成器；测试可注入确定值 */
  opId?: () => string;
};

const defaultNonce = () => Math.floor(Math.random() * 1_000_000_000);
const defaultOpId = () => globalThis.crypto.randomUUID();

function isSupportedType(type: unknown): type is ElementType {
  return typeof type === "string" && (ELEMENT_TYPES as readonly string[]).includes(type);
}

export function snapshotOf(el: MinimalElement): ElementSnapshot {
  const snapshot: ElementSnapshot = {
    id: el.id,
    version: el.version,
    versionNonce: el.versionNonce,
    isDeleted: el.isDeleted,
  };
  if (isSupportedType(el.type)) snapshot.type = el.type;
  return snapshot;
}

export function snapshotMap(elements: readonly MinimalElement[]): Map<string, ElementSnapshot> {
  const map = new Map<string, ElementSnapshot>();
  for (const el of elements) map.set(el.id, snapshotOf(el));
  return map;
}

function zindexKeyOf(el: MinimalElement, position: number): string {
  const index = el.index;
  if (typeof index === "string" && index.length > 0) return index;
  if (typeof index === "number" && Number.isFinite(index)) return String(index);
  return `a${String(position).padStart(8, "0")}`;
}

function dataOf(el: MinimalElement): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(el)) data[key] = value;
  return data;
}

/**
 * 规则：
 * - 新增 -> `upsert`，`baseVersion = null`
 * - `version` 变大 -> `upsert`，`baseVersion = 旧 version`
 * - 同一 id 且 `isDeleted` 变 true -> `delete`（墓碑，版本由元素自身带）
 * - 从数组里消失且旧帧未删除 -> 合成 `delete`，`version = 旧 version + 1`
 * - 版本/决胜随机数/墓碑标记都没变 -> 不产出（纯交互噪声 0 op）
 *
 * 已知限制：`elements.type` 的库内约束只允许 7 种，Excalidraw 的 `line` / `image` /
 * `frame` 等类型目前会被跳过（不产出 op），等 M5 再决定是扩约束还是做映射。
 */
export function diffElements(
  prev: Map<string, ElementSnapshot>,
  next: readonly MinimalElement[],
  options: DeriveOptions = {},
): ElementOp[] {
  const nonce = options.nonce ?? defaultNonce;
  const opId = options.opId ?? defaultOpId;
  const ops: ElementOp[] = [];
  const seen = new Set<string>();

  for (const [position, el] of next.entries()) {
    seen.add(el.id);
    if (!isSupportedType(el.type)) continue;
    const old = prev.get(el.id);

    if (!old) {
      ops.push(
        el.isDeleted
          ? {
              opId: opId(),
              kind: "delete",
              id: el.id,
              type: el.type,
              baseVersion: Math.max(0, el.version - 1),
              version: el.version,
              versionNonce: el.versionNonce,
            }
          : {
              opId: opId(),
              kind: "upsert",
              id: el.id,
              type: el.type,
              baseVersion: null,
              version: el.version,
              versionNonce: el.versionNonce,
              data: dataOf(el),
              zindexKey: zindexKeyOf(el, position),
            },
      );
      continue;
    }

    if (old.version !== el.version || old.versionNonce !== el.versionNonce || old.isDeleted !== el.isDeleted) {
      ops.push(
        el.isDeleted
          ? {
              opId: opId(),
              kind: "delete",
              id: el.id,
              type: el.type,
              baseVersion: old.version,
              version: el.version,
              versionNonce: el.versionNonce,
            }
          : {
              opId: opId(),
              kind: "upsert",
              id: el.id,
              type: el.type,
              baseVersion: old.version,
              version: el.version,
              versionNonce: el.versionNonce,
              data: dataOf(el),
              zindexKey: zindexKeyOf(el, position),
            },
      );
    }
  }

  for (const [id, old] of prev) {
    if (seen.has(id) || old.isDeleted || !isSupportedType(old.type)) continue;
    ops.push({
      opId: opId(),
      kind: "delete",
      id,
      type: old.type,
      baseVersion: old.version,
      version: old.version + 1,
      versionNonce: nonce(),
    });
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
