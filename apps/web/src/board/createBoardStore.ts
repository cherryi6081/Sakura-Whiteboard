import type { ElementOp } from "@whiteboard/shared";
import {
  createBoardCollab,
  type BoardCollab,
  type CanvasBridge,
  type CollabCache,
  type CollabSnapshot,
  type RemoteCursor,
} from "../collab/BoardCollab";
import type { PresenceStatePayload, CursorPayload } from "../collab/socketClient";
import {
  cacheDebugInfo,
  clearQueuedOps,
  enqueueOps,
  getCachedSeq,
  listQueuedOps,
  removeQueuedOps,
  writeCachedScene,
} from "../store/cacheDb";
import { createWriterLease, type WriterLeaseSnapshot } from "../store/writerLease";
import { resolveTabIdentity, type GuestUser, type TabHandshakeEvent, type TabIdentity } from "./tabIdentity";

/**
 * M3：**每标签、每板**一个 store 实例。
 *
 * `BoardPage` 只允许通过 `createBoardStore(boardId)` 拿协作/缓存/在场状态；
 * 模块里不再导出任何"当前白板 store"之类的可变单例（评审清单 §6.4 第 1 条）。
 *
 * 组成：
 * - `resolveTabIdentity`：sessionStorage 里的 tabId + `wb-handshake` 重复检测（复制标签场景）；
 * - `createWriterLease`：Web Locks 选举 `board:{id}:cache-writer`，只有写者落盘元素快照；
 * - `createBoardCollab`：Socket / op / presence / cursor；
 * - `BroadcastChannel('board:{id}')`：写者落盘后广播失效通知（当前只记录，不做自动重载）。
 */

export type CacheWriteStats = {
  writes: number;
  /** 非写者标签跳过整板快照写的次数（验收要看这个） */
  skipped: number;
};

export type CacheInvalidation = {
  count: number;
  lastSeq: number | null;
  lastAt: number | null;
};

export type BoardStoreSnapshot = {
  boardId: string;
  tabId: string;
  guestId: string;
  /** M5-1：是否已登录 + 当前用户（游客为 null） */
  authenticated: boolean;
  user: GuestUser | null;
  tabSupported: boolean;
  tabRegenerated: boolean;
  tabEvents: TabHandshakeEvent[];
  writer: WriterLeaseSnapshot & CacheWriteStats;
  invalidation: CacheInvalidation;
  /** 旧连接因 tabId 变更而退场的次数（运行期重复检测用） */
  retiredConnections: number;
  collab: CollabSnapshot | null;
};

type IdentityCheck = {
  previous: string | null;
  tabId: string;
  changed: boolean;
  regenerated: boolean;
  events: TabHandshakeEvent[];
};

export type BoardStore = ReturnType<typeof createBoardStore>;

type CacheInvalidationMessage = { type: "cache:updated"; boardId: string; seq: number; at: number };

export function createBoardStore(options: {
  boardId: string;
  viewOnly: boolean;
  getBridge: () => CanvasBridge | null;
  onChange?: (snapshot: BoardStoreSnapshot) => void;
}) {
  const { boardId } = options;

  let started = false;
  let stopped = false;
  let tabIdentity: TabIdentity | null = null;
  let lease: ReturnType<typeof createWriterLease> | null = null;
  let collab: BoardCollab | null = null;
  let channel: BroadcastChannel | null = null;
  let collabSnapshot: CollabSnapshot | null = null;
  let retiredConnections = 0;

  const cacheStats: CacheWriteStats = { writes: 0, skipped: 0 };
  const invalidation: CacheInvalidation = { count: 0, lastSeq: null, lastAt: null };

  const notify = () => options.onChange?.(snapshot());

  /**
   * 缓存门禁：只有 Web Locks 的写者允许**整板覆盖写**；
   * `enqueue/removeQueued` 因为按 `opId` 唯一键，不会互相覆盖，所有标签都可以写，
   * 否则非写者标签断线时自己的待发 op 会丢（见开发文档 §6 实现差异）。
   */
  const guardedCache: CollabCache = {
    getSeq: getCachedSeq,
    writeScene: async (targetBoardId, elements, seq) => {
      if (!lease?.isWriter()) {
        cacheStats.skipped += 1;
        return;
      }
      await writeCachedScene(targetBoardId, elements, seq);
      cacheStats.writes += 1;
      // 失效通知：同板其它标签收到后知道"缓存水位可能变了"
      try {
        channel?.postMessage({
          type: "cache:updated",
          boardId: targetBoardId,
          seq,
          at: Date.now(),
        } satisfies CacheInvalidationMessage);
      } catch {
        /* channel 已关闭 */
      }
    },
    enqueue: enqueueOps,
    listQueued: listQueuedOps,
    removeQueued: removeQueuedOps,
    clearQueue: clearQueuedOps,
  };

  const createCollab = (tab: TabIdentity) =>
    createBoardCollab({
      boardId,
      viewOnly: options.viewOnly,
      tabId: tab.tabId,
      guestId: tab.guestId,
      cache: guardedCache,
      getBridge: options.getBridge,
      onChange: (snapshot) => {
        collabSnapshot = snapshot;
        notify();
      },
    });

  const startLease = (tab: TabIdentity) => {
    lease = createWriterLease({ boardId, tabId: tab.tabId, bootedAt: tab.bootedAt });
    lease.start();
  };

  const openInvalidationChannel = () => {
    if (typeof BroadcastChannel === "undefined") return;
    channel = new BroadcastChannel(`board:${boardId}`);
    channel.onmessage = (event: MessageEvent<CacheInvalidationMessage>) => {
      const message = event.data;
      if (!message || message.type !== "cache:updated" || message.boardId !== boardId) return;
      invalidation.count += 1;
      invalidation.lastSeq = message.seq;
      invalidation.lastAt = message.at;
      notify();
    };
  };

  const init = async () => {
    const tab = await resolveTabIdentity({ boardId });
    tabIdentity = tab;
    if (stopped) {
      tab.dispose();
      return;
    }
    startLease(tab);
    openInvalidationChannel();
    collab = createCollab(tab);
    collab.start();
    notify();
  };

  function snapshot(): BoardStoreSnapshot {
    return {
      boardId,
      tabId: tabIdentity?.tabId ?? "",
      guestId: tabIdentity?.guestId ?? "",
      authenticated: tabIdentity?.authenticated ?? false,
      user: tabIdentity?.user ?? null,
      tabSupported: tabIdentity?.supported ?? false,
      tabRegenerated: tabIdentity?.regenerated ?? false,
      tabEvents: tabIdentity ? [...tabIdentity.events] : [],
      writer: {
        ...(lease?.snapshot() ?? {
          supported: false,
          mode: "none" as const,
          lockName: `board:${boardId}:cache-writer`,
          tabId: tabIdentity?.tabId ?? "",
          isWriter: false,
          acquiredAt: null,
          releasedAt: null,
          events: [],
        }),
        ...cacheStats,
      },
      invalidation: { ...invalidation },
      retiredConnections,
      collab: collabSnapshot,
    };
  }

  return {
    boardId,
    start() {
      if (started) return;
      started = true;
      void init();
    },
    stop() {
      stopped = true;
      // 先停协作层（此时仍持锁，最后的整板落盘不会被门禁拦下），再释放锁与频道
      collab?.stop();
      collab = null;
      collabSnapshot = null;
      lease?.stop();
      lease = null;
      tabIdentity?.dispose();
      tabIdentity = null;
      channel?.close();
      channel = null;
    },
    snapshot,
    submit: (ops: readonly ElementOp[]) => collab?.submit(ops),
    sendCursor: (x: number, y: number) => collab?.sendCursor(x, y),
    notifyCanvasReady: () => collab?.notifyCanvasReady(),
    syncNow: () => collab?.syncNow(),
    debugDisconnect: () => collab?.debugDisconnect(),
    debugConnect: () => collab?.debugConnect(),
    cacheInfo: () => cacheDebugInfo(boardId),
    /** 运行期重新握手：若 sessionStorage 被复制成重复 tabId，就重生成并让旧连接退场。 */
    async recheckTabIdentity(): Promise<IdentityCheck> {
      const previous = tabIdentity?.tabId ?? null;
      // 先关掉旧频道，避免同一页面的两个频道同时收到 duplicate 而重复重生成
      tabIdentity?.dispose();
      tabIdentity = null;
      const tab = await resolveTabIdentity({ boardId });
      const changed = previous !== null && previous !== tab.tabId;

      tabIdentity = tab;

      if (changed) {
        retiredConnections += 1;
        console.info(`[tab] tabId 由 ${previous} 变为 ${tab.tabId}：旧连接退场，按新 tabId 重连`);
        collab?.stop();
        collab = null;
        collabSnapshot = null;
        lease?.stop();
        lease = null;
        if (!stopped) {
          startLease(tab);
          collab = createCollab(tab);
          collab.start();
        }
      }

      notify();
      return { previous, tabId: tab.tabId, changed, regenerated: tab.regenerated, events: [...tab.events] };
    },
  };
}

/** 导出给渲染层做"远端光标/在场"的类型收窄，避免重复定义。 */
export type { CursorPayload, RemoteCursor, PresenceStatePayload };
