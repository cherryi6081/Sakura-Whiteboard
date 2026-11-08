import { afterEach, describe, expect, it, vi } from "vitest";
import type { ElementDeleteOp, ElementOp, ElementUpsertOp } from "@whiteboard/shared";
import {
  createOpBatcher,
  createOpDeriver,
  diffElements,
  snapshotMap,
  type MinimalElement,
} from "./deriveOps";

function el(id: string, version: number, isDeleted = false, versionNonce = 7): MinimalElement {
  return { id, type: "rectangle", version, versionNonce, isDeleted, index: `a${id}` };
}

/** 固定 opId 序列，避免断言里出现随机值 */
function makeOpIds() {
  let n = 0;
  return () => `op-${++n}`;
}

function upsert(
  id: string,
  baseVersion: number | null,
  version: number,
  versionNonce = 7,
  opId = `u-${id}-${version}`,
): ElementUpsertOp {
  return {
    opId,
    kind: "upsert",
    id,
    type: "rectangle",
    baseVersion,
    version,
    versionNonce,
    data: { id, type: "rectangle", version, versionNonce, isDeleted: false, index: `a${id}` },
    zindexKey: `a${id}`,
  };
}

function del(
  id: string,
  baseVersion: number,
  version: number,
  versionNonce = 7,
  opId = `d-${id}-${version}`,
): ElementDeleteOp {
  return { opId, kind: "delete", id, type: "rectangle", baseVersion, version, versionNonce };
}

describe("diffElements", () => {
  it("新增元素 -> 1 条 upsert，baseVersion 为 null", () => {
    const next = el("a", 1);
    const ops = diffElements(snapshotMap([]), [next], { opId: makeOpIds() });
    expect(ops).toEqual([upsert("a", null, 1, 7, "op-1")]);
    expect(ops[0]).toMatchObject({ data: next });
  });

  it("版本变大 -> 1 条 upsert，baseVersion 为旧版本", () => {
    const next = el("a", 2, false, 9);
    const ops = diffElements(snapshotMap([el("a", 1)]), [next], { opId: makeOpIds() });
    expect(ops).toEqual([upsert("a", 1, 2, 9, "op-1")]);
  });

  it("转墓碑 -> 1 条 delete，版本随元素递增", () => {
    const ops = diffElements(snapshotMap([el("a", 2)]), [el("a", 3, true, 11)], { opId: makeOpIds() });
    expect(ops).toEqual([del("a", 2, 3, 11, "op-1")]);
  });

  it("无变化 -> 0 op", () => {
    const ops = diffElements(snapshotMap([el("a", 3, true)]), [el("a", 3, true)], { opId: makeOpIds() });
    expect(ops).toEqual([]);
  });

  it("纯交互噪声（同一帧重复多次）-> 0 op", () => {
    const deriver = createOpDeriver({ opId: makeOpIds() });
    deriver.reset([el("a", 5), el("b", 8, true)]);
    expect(deriver.derive([el("a", 5), el("b", 8, true)])).toEqual([]);
    expect(deriver.derive([el("a", 5), el("b", 8, true)])).toEqual([]);
    expect(deriver.derive([el("a", 5), el("b", 8, true)])).toEqual([]);
  });

  it("元素从数组消失 -> 合成 delete（旧版本 + 1，墓碑语义）", () => {
    const ops = diffElements(snapshotMap([el("a", 4)]), [], { nonce: () => 42, opId: makeOpIds() });
    expect(ops).toEqual([del("a", 4, 5, 42, "op-1")]);
  });

  it("已墓碑的元素再消失 -> 不重复产出 delete", () => {
    const ops = diffElements(snapshotMap([el("a", 5, true)]), [], { nonce: () => 42, opId: makeOpIds() });
    expect(ops).toEqual([]);
  });

  it("库内约束不支持的类型（如 line）-> 跳过，不产出 op", () => {
    const line: MinimalElement = { id: "l", type: "line", version: 1, versionNonce: 1, isDeleted: false };
    const ops = diffElements(snapshotMap([]), [line], { opId: makeOpIds() });
    expect(ops).toEqual([]);
  });
});

describe("createOpBatcher", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("50ms 静默后 flush，同 id 只保留最后一条", () => {
    vi.useFakeTimers();
    const flushed: ElementOp[][] = [];
    const batcher = createOpBatcher({ onFlush: (ops) => flushed.push(ops) });

    batcher.push([upsert("a", 0, 1, 1)]);
    batcher.push([upsert("a", 1, 2, 2)]);
    batcher.push([upsert("b", null, 1, 3)]);
    expect(batcher.pendingCount()).toBe(2);

    vi.advanceTimersByTime(50);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toEqual([upsert("a", 1, 2, 2), upsert("b", null, 1, 3)]);
    expect(batcher.pendingCount()).toBe(0);
  });

  it("flushNow（pointerup）立即发送，不等 50ms", () => {
    vi.useFakeTimers();
    const flushed: ElementOp[][] = [];
    const batcher = createOpBatcher({ onFlush: (ops) => flushed.push(ops) });

    batcher.push([del("a", 3, 4, 5)]);
    batcher.flushNow();

    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toEqual([del("a", 3, 4, 5)]);

    vi.advanceTimersByTime(50);
    expect(flushed).toHaveLength(1);
  });

  it("dispose 后不再触发定时 flush", () => {
    vi.useFakeTimers();
    const flushed: ElementOp[][] = [];
    const batcher = createOpBatcher({ onFlush: (ops) => flushed.push(ops) });

    batcher.push([upsert("a", null, 1, 1)]);
    batcher.dispose();
    vi.advanceTimersByTime(100);
    expect(flushed).toHaveLength(0);
  });
});
