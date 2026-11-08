import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOpBatcher,
  createOpDeriver,
  diffElements,
  snapshotMap,
  type MinimalElement,
} from "./deriveOps";

function el(id: string, version: number, isDeleted = false, versionNonce = 7): MinimalElement {
  return { id, version, versionNonce, isDeleted };
}

describe("diffElements", () => {
  it("新增元素 -> 1 条 upsert，baseVersion 为 null", () => {
    const ops = diffElements(snapshotMap([]), [el("a", 1)]);
    expect(ops).toEqual([{ kind: "upsert", id: "a", baseVersion: null, version: 1, versionNonce: 7 }]);
  });

  it("版本变大 -> 1 条 upsert，baseVersion 为旧版本", () => {
    const ops = diffElements(snapshotMap([el("a", 1)]), [el("a", 2, false, 9)]);
    expect(ops).toEqual([{ kind: "upsert", id: "a", baseVersion: 1, version: 2, versionNonce: 9 }]);
  });

  it("转墓碑 -> 1 条 delete，版本随元素递增", () => {
    const ops = diffElements(snapshotMap([el("a", 2)]), [el("a", 3, true, 11)]);
    expect(ops).toEqual([{ kind: "delete", id: "a", baseVersion: 2, version: 3, versionNonce: 11 }]);
  });

  it("无变化 -> 0 op", () => {
    const ops = diffElements(snapshotMap([el("a", 3, true)]), [el("a", 3, true)]);
    expect(ops).toEqual([]);
  });

  it("纯交互噪声（同一帧重复多次）-> 0 op", () => {
    const deriver = createOpDeriver();
    deriver.reset([el("a", 5), el("b", 8, true)]);
    expect(deriver.derive([el("a", 5), el("b", 8, true)])).toEqual([]);
    expect(deriver.derive([el("a", 5), el("b", 8, true)])).toEqual([]);
    expect(deriver.derive([el("a", 5), el("b", 8, true)])).toEqual([]);
  });

  it("元素从数组消失 -> 合成 delete（旧版本 + 1，墓碑语义）", () => {
    const ops = diffElements(snapshotMap([el("a", 4)]), [], { nonce: () => 42 });
    expect(ops).toEqual([{ kind: "delete", id: "a", baseVersion: 4, version: 5, versionNonce: 42 }]);
  });

  it("已墓碑的元素再消失 -> 不重复产出 delete", () => {
    const ops = diffElements(snapshotMap([el("a", 5, true)]), [], { nonce: () => 42 });
    expect(ops).toEqual([]);
  });
});

describe("createOpBatcher", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("50ms 静默后 flush，同 id 只保留最后一条", () => {
    vi.useFakeTimers();
    const flushed: unknown[][] = [];
    const batcher = createOpBatcher({ onFlush: (ops) => flushed.push(ops) });

    batcher.push([{ kind: "upsert", id: "a", baseVersion: 0, version: 1, versionNonce: 1 }]);
    batcher.push([{ kind: "upsert", id: "a", baseVersion: 1, version: 2, versionNonce: 2 }]);
    batcher.push([{ kind: "upsert", id: "b", baseVersion: null, version: 1, versionNonce: 3 }]);
    expect(batcher.pendingCount()).toBe(2);

    vi.advanceTimersByTime(50);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toEqual([
      { kind: "upsert", id: "a", baseVersion: 1, version: 2, versionNonce: 2 },
      { kind: "upsert", id: "b", baseVersion: null, version: 1, versionNonce: 3 },
    ]);
    expect(batcher.pendingCount()).toBe(0);
  });

  it("flushNow（pointerup）立即发送，不等 50ms", () => {
    vi.useFakeTimers();
    const flushed: unknown[][] = [];
    const batcher = createOpBatcher({ onFlush: (ops) => flushed.push(ops) });

    batcher.push([{ kind: "delete", id: "a", baseVersion: 3, version: 4, versionNonce: 5 }]);
    batcher.flushNow();

    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toEqual([{ kind: "delete", id: "a", baseVersion: 3, version: 4, versionNonce: 5 }]);

    vi.advanceTimersByTime(50);
    expect(flushed).toHaveLength(1);
  });

  it("dispose 后不再触发定时 flush", () => {
    vi.useFakeTimers();
    const flushed: unknown[][] = [];
    const batcher = createOpBatcher({ onFlush: (ops) => flushed.push(ops) });

    batcher.push([{ kind: "upsert", id: "a", baseVersion: null, version: 1, versionNonce: 1 }]);
    batcher.dispose();
    vi.advanceTimersByTime(100);
    expect(flushed).toHaveLength(0);
  });
});
