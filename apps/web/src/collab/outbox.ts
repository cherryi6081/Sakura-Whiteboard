import type { OpBatch } from "@whiteboard/shared";

export type OutboxOptions = {
  /** 最多缓存多少个批次（断线重连后一次性补发） */
  max?: number;
  /** 超出上限时丢弃最旧的批次；由调用方负责提示，不做静默丢弃 */
  onDrop?: (batch: OpBatch) => void;
};

/**
 * M2-C4 的断线策略：**排队 + 重连后补发**。
 *
 * 选排队而不是"提示后丢弃"的理由：
 * - op 自带 `baseVersion` / `version` / `versionNonce`，补发后仍由服务端 LWW 裁决，
 *   过期也不会污染最终状态；
 * - 断线通常只有几秒，排队能保住用户刚画的内容；
 * - 队列有上限，超出时通过 `onDrop` 明确提示（控制台 + 状态栏计数），不静默丢。
 *
 * 已知边界：队列只在内存里，页面刷新/关闭会丢；完整补拉与持久化队列留到 C5。
 */
export function createOutbox({ max = 100, onDrop }: OutboxOptions = {}) {
  let batches: OpBatch[] = [];

  return {
    push(batch: OpBatch) {
      batches.push(batch);
      while (batches.length > max) {
        const dropped = batches.shift();
        if (dropped) onDrop?.(dropped);
      }
    },
    drain(): OpBatch[] {
      const all = batches;
      batches = [];
      return all;
    },
    size: () => batches.length,
    clear() {
      batches = [];
    },
  };
}

export type Outbox = ReturnType<typeof createOutbox>;
