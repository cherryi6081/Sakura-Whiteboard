import { describe, expect, it, vi } from "vitest";
import type { OpBatch } from "@whiteboard/shared";
import { createOutbox } from "./outbox";

const batch = (opId: string): OpBatch => ({
  boardId: "outboxboard0",
  clientId: "outbox-client",
  ops: [
    {
      opId,
      kind: "upsert",
      id: `el-${opId}`,
      type: "rectangle",
      baseVersion: null,
      version: 1,
      versionNonce: 1,
      data: {},
      zindexKey: "a1",
    },
  ],
});

describe('createOutbox（断线排队）', () => {
  it('按顺序缓存、drain 后清空', () => {
    const outbox = createOutbox();
    outbox.push(batch("op-1"));
    outbox.push(batch("op-2"));
    expect(outbox.size()).toBe(2);

    const drained = outbox.drain();
    expect(drained.map((b) => b.ops[0].opId)).toEqual(["op-1", "op-2"]);
    expect(outbox.size()).toBe(0);
    expect(outbox.drain()).toEqual([]);
  });

  it('超过上限时丢弃最旧批次并回调提示', () => {
    const onDrop = vi.fn();
    const outbox = createOutbox({ max: 2, onDrop });
    outbox.push(batch("op-1"));
    outbox.push(batch("op-2"));
    outbox.push(batch("op-3"));

    expect(outbox.size()).toBe(2);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop.mock.calls[0][0].ops[0].opId).toBe("op-1");
    expect(outbox.drain().map((b) => b.ops[0].opId)).toEqual(["op-2", "op-3"]);
  });
});
