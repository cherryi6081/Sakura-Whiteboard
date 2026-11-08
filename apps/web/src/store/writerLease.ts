/**
 * M3：同板多标签的 IndexedDB 写者选举。
 *
 * 目标（开发文档 §6.3-A）：同一块板只允许**一个**标签写元素快照（整板覆盖写），
 * 其余标签只读，避免两个标签各自 `writeCachedScene` 互相覆盖。
 *
 * 首选 **Web Locks**：每个标签对 `board:{boardId}:cache-writer` 排队申请独占锁；
 * 拿到锁的标签成为写者，关闭标签/刷新时锁自动释放，队列里的下一个标签接手。
 *
 * 降级（`navigator.locks` 不存在，如旧版 Safari/Firefox 或非安全上下文）：
 * 用 `BroadcastChannel('board:{id}:writer')` 做**最早的标签优先**选举：
 * 每标签广播自己的 `bootedAt`，全部标签取最小值（平局比 tabId）作为写者；
 * 标签关闭时广播 bye 触发重选。该路径不依赖存储，不会污染 localStorage。
 *
 * 再降级（连 BroadcastChannel 也没有）：只能认为自己是写者（单标签场景可用；
 * 多标签同时写有覆盖风险，文档标注为已知边界）。
 */

export type WriterMode = "web-locks" | "broadcast-fallback" | "none";

export type WriterCandidate = { tabId: string; bootedAt: number };

/** 最早的标签优先；`bootedAt` 平局时 tabId 字典序小者优先（保证各标签结果一致）。 */
export function electWriter(candidates: readonly WriterCandidate[]): string | null {
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => {
    if (a.bootedAt !== b.bootedAt) return a.bootedAt - b.bootedAt;
    return a.tabId < b.tabId ? -1 : a.tabId > b.tabId ? 1 : 0;
  });
  return (sorted[0] as WriterCandidate).tabId;
}

export type WriterLeaseSnapshot = {
  supported: boolean;
  mode: WriterMode;
  lockName: string;
  tabId: string;
  isWriter: boolean;
  acquiredAt: number | null;
  releasedAt: number | null;
  /** 选举事件（验收日志） */
  events: string[];
};

export type WriterLease = {
  start: () => void;
  stop: () => void;
  isWriter: () => boolean;
  snapshot: () => WriterLeaseSnapshot;
};

type LeaseMessage =
  | { type: "hello"; tabId: string; bootedAt: number }
  | { type: "bye"; tabId: string };

export function createWriterLease(options: {
  boardId: string;
  tabId: string;
  bootedAt: number;
  now?: () => number;
}): WriterLease {
  const { boardId, tabId, bootedAt } = options;
  const now = options.now ?? (() => Date.now());
  const lockName = `board:${boardId}:cache-writer`;

  const events: string[] = [];
  let isWriter = false;
  let acquiredAt: number | null = null;
  let releasedAt: number | null = null;
  let mode: WriterMode = "none";
  let abort: AbortController | null = null;
  let channel: BroadcastChannel | null = null;
  let peerBoot: Map<string, number> | null = null;
  let started = false;
  let stopped = false;
  /** Web Locks 回调里挂起的释放句柄（每实例一份，不放模块作用域） */
  let release: (() => void) | null = null;

  const setWriter = (next: boolean, reason: string) => {
    if (isWriter === next) return;
    isWriter = next;
    if (next) acquiredAt = now();
    else releasedAt = now();
    events.push(`${reason}:${next ? "writer" : "reader"}@${acquiredAt ?? releasedAt}`);
  };

  const locksSupported = (): boolean =>
    typeof navigator !== "undefined" && typeof navigator.locks?.request === "function";

  const startBroadcastFallback = () => {
    mode = typeof BroadcastChannel !== "undefined" ? "broadcast-fallback" : "none";
    if (mode === "none") {
      // 无 Web Locks 也无 BroadcastChannel：无法证明独占，退化为"自认写者"。仅单标签安全。
      setWriter(true, "no-election");
      events.push("degraded:no-election");
      return;
    }

    peerBoot = new Map([[tabId, bootedAt]]);
    channel = new BroadcastChannel(`board:${boardId}:writer`);
    const reelect = (reason: string) => {
      const winner = electWriter([...(peerBoot ?? new Map()).entries()].map(([id, boot]) => ({ tabId: id, bootedAt: boot })));
      setWriter(winner === tabId, reason);
    };
    channel.onmessage = (event: MessageEvent<LeaseMessage>) => {
      const message = event.data;
      if (!message || message.type === undefined) return;
      if (message.type === "hello") {
        peerBoot?.set(message.tabId, message.bootedAt);
        reelect("fallback-reelect");
      } else if (message.type === "bye") {
        peerBoot?.delete(message.tabId);
        reelect("fallback-reelect");
      }
    };
    channel.postMessage({ type: "hello", tabId, bootedAt } satisfies LeaseMessage);
    events.push("fallback:hello");
    reelect("fallback-initial");
  };

  return {
    start() {
      if (started) return;
      started = true;
      if (locksSupported()) {
        mode = "web-locks";
        abort = new AbortController();
        void navigator.locks
          .request(lockName, { mode: "exclusive", signal: abort.signal }, async () => {
            setWriter(true, "lock");
            events.push("lock:acquired");
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            setWriter(false, "lock");
          })
          .catch((err: unknown) => {
            // 被 stop() 取消属于正常路径
            if (!stopped) {
              events.push(`lock:error:${err instanceof Error ? err.name : String(err)}`);
              startBroadcastFallback();
            }
          });
      } else {
        startBroadcastFallback();
      }
    },
    stop() {
      stopped = true;
      abort?.abort();
      release?.();
      release = null;
      try {
        channel?.postMessage({ type: "bye", tabId } satisfies LeaseMessage);
        channel?.close();
      } catch {
        /* ignore */
      }
      channel = null;
      peerBoot = null;
    },
    isWriter: () => isWriter,
    snapshot: (): WriterLeaseSnapshot => ({
      supported: locksSupported() || mode === "broadcast-fallback",
      mode,
      lockName,
      tabId,
      isWriter,
      acquiredAt,
      releasedAt,
      events: [...events],
    }),
  };
}
