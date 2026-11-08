import { LIMITS, type ElementOp, type OpBatch } from "@whiteboard/shared";
import { decideResync } from "../store/cachePolicy";
import { fetchOpsPage, fetchSnapshot, type PulledOp } from "./boardApi";
import { decideRemoteApply } from "./lww";
import {
  createBoardSocket,
  type AckPayload,
  type ApplyPayload,
  type BoardSocket,
  type ConnectionStatus,
  type CursorPayload,
  type JoinRole,
  type JoinedPayload,
  type PresenceStatePayload,
  type RejectedPayload,
} from "./socketClient";

export type SceneElement = {
  id: string;
  version: number;
  versionNonce: number;
  isDeleted?: boolean;
  [key: string]: unknown;
};

/** 渲染层交给协作层的窄接口：取当前场景 + 无损回放远端元素。 */
export type CanvasBridge = {
  getElements: () => readonly SceneElement[];
  applyRemoteElements: (elements: readonly SceneElement[]) => void;
};

/** 持久化缓存的窄接口（实现见 `store/cacheDb.ts`，便于替换/单测）。 */
export type CollabCache = {
  getSeq: (boardId: string) => Promise<number | null>;
  writeScene: (boardId: string, elements: readonly SceneElement[], seq: number) => Promise<void>;
  enqueue: (boardId: string, ops: readonly ElementOp[]) => Promise<void>;
  listQueued: (boardId: string) => Promise<readonly { op: ElementOp }[]>;
  removeQueued: (opIds: readonly string[]) => Promise<void>;
  clearQueue: (boardId: string) => Promise<void>;
};

/** M3：远端光标按**连接**保存（同一用户多标签会有多条，各自位置不可合并）。 */
export type RemoteCursor = {
  connectionId: string;
  clientId: string;
  tabId: string | null;
  identity: string;
  color: string;
  x: number;
  y: number;
  at: number;
};

export type CollabSnapshot = {
  boardId: string;
  clientId: string;
  /** M3：本标签的 tabId 与浏览器级 guestId */
  tabId: string;
  guestId: string;
  status: ConnectionStatus;
  joined: boolean;
  role: JoinRole | "unknown";
  viewOnly: boolean;
  identity: string | null;
  serverSeq: number | null;
  submittedBatches: number;
  submittedOps: number;
  /** 持久化队列里尚未确认的 op 数（刷新后仍然存在） */
  queuedOps: number;
  appliedRemote: number;
  ignoredRemote: number;
  deferredRemote: number;
  lastApplySeq: number | null;
  lastAck: AckPayload | null;
  staleIds: string[];
  rejected: RejectedPayload[];
  /** 本地缓存的同步水位 */
  cacheSeq: number | null;
  synced: boolean;
  lastPullSince: number | null;
  lastPullCount: number;
  pullPages: number;
  resyncCount: number;
  lastPullResync: boolean;
  /** M3：按用户聚合的 presence（头像一个 + ×N 标签页） */
  presence: PresenceStatePayload | null;
  /** M3：按连接渲染的远端光标 */
  cursors: RemoteCursor[];
};

export type BoardCollab = ReturnType<typeof createBoardCollab>;

const MAX_REJECTIONS = 20;
/** 补拉分页的安全上限：防止服务端异常导致死循环 */
const MAX_PULL_PAGES = 20;
/** 已本地确认的 opId，避免"先 ack 后落盘"的竞态在队列里留下幽灵记录 */
const MAX_SETTLED_IDS = 4000;
/** 远端光标上限（异常客户端刷光标也不至于把内存打爆） */
const MAX_CURSORS = 40;
/** 光标上行节流：约 16Hz，够顺滑又不至于每个 pointermove 都发一帧 */
const CURSOR_INTERVAL_MS = 60;

/**
 * M2-C5 协作控制器：
 *
 * - 上行：`BoardCanvas.onOps` → `submit`；**先落 IndexedDB 队列，再发 `op:submit`**，
 *   收到 `op:ack` / 终态 `op:rejected` 才从队列删除。断线与刷新都能续传，服务端按 `opId` 幂等。
 * - 下行：`op:apply` 按 LWW 合并后 `updateScene(NEVER)`，不进本地撤销栈；指针按下期间排队。
 * - 启动顺序：页面先用本地缓存渲染（`loadScene`），随后 `join` 拿服务端 `last_seq`，
 *   再用 `since = 本地缓存 seq` 调 REST 补拉；落后超过阈值或接口要求 `resync` 时整板快照重载。
 * - viewer 不产 op；服务端仍然独立拒绝写（见 server `resolveJoinRole`）。
 */
export function createBoardCollab(options: {
  boardId: string;
  viewOnly: boolean;
  clientId?: string;
  /** M3：每标签一条（sessionStorage） */
  tabId: string;
  /** M3：浏览器级游客标识（cookie `wb_gid`），presence 按它聚合 */
  guestId: string;
  cache: CollabCache;
  getBridge: () => CanvasBridge | null;
  onChange?: (snapshot: CollabSnapshot) => void;
}) {
  const clientId = options.clientId ?? `web_${globalThis.crypto.randomUUID().slice(0, 13)}`;
  const cache = options.cache;

  const state: CollabSnapshot = {
    boardId: options.boardId,
    clientId,
    tabId: options.tabId,
    guestId: options.guestId,
    status: "connecting",
    joined: false,
    role: "unknown",
    viewOnly: options.viewOnly,
    identity: null,
    serverSeq: null,
    submittedBatches: 0,
    submittedOps: 0,
    queuedOps: 0,
    appliedRemote: 0,
    ignoredRemote: 0,
    deferredRemote: 0,
    lastApplySeq: null,
    lastAck: null,
    staleIds: [],
    rejected: [],
    cacheSeq: null,
    synced: false,
    lastPullSince: null,
    lastPullCount: 0,
    pullPages: 0,
    resyncCount: 0,
    lastPullResync: false,
    presence: null,
    cursors: [],
  };

  const pendingRemote: ApplyPayload[] = [];
  const settledOpIds = new Set<string>();
  let pendingReplace: SceneElement[] | null = null;
  let pendingCacheSeq: number | null = null;
  let pointerDown = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let persistSeq: number | null = null;
  let socket: BoardSocket | null = null;
  let stopped = false;
  let lastCursorAt = 0;

  const emit = () => {
    options.onChange?.({
      ...state,
      staleIds: [...state.staleIds],
      rejected: [...state.rejected],
      cursors: [...state.cursors],
      presence: state.presence
        ? {
            ...state.presence,
            users: state.presence.users.map((user) => ({
              ...user,
              tabIds: [...user.tabIds],
              connectionIds: [...user.connectionIds],
            })),
          }
        : null,
    });
  };

  /** 缓存操作失败不应该弄挂协作主链路：记录并继续。 */
  const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      console.warn("[collab] 本地缓存操作失败", err);
      return fallback;
    }
  };

  const canWrite = () => {
    if (state.viewOnly) return false;
    if (state.role === "viewer") return false;
    // 尚未 joined 时不阻断：op 先落队列，等拿到角色后再决定发送或丢弃
    return true;
  };

  const refreshQueuedOps = async () => {
    const queued = await safe(() => cache.listQueued(state.boardId), []);
    state.queuedOps = queued.length;
    emit();
  };

  const markSettled = (opId: string) => {
    settledOpIds.add(opId);
    if (settledOpIds.size > MAX_SETTLED_IDS) settledOpIds.clear();
    void safe(() => cache.removeQueued([opId]), undefined).then(refreshQueuedOps);
  };

  /**
   * 先落盘再发送。若 ack 比落盘更快（同一 tick 内），落盘完成后立刻按 `settledOpIds` 删除。
   */
  const persistEnqueue = async (ops: readonly ElementOp[]) => {
    await safe(() => cache.enqueue(state.boardId, ops), undefined);
    const settledNow = ops.filter((op) => settledOpIds.has(op.opId)).map((op) => op.opId);
    if (settledNow.length > 0) await safe(() => cache.removeQueued(settledNow), undefined);
    await refreshQueuedOps();
  };

  const persistSceneAndSeq = async (seq: number) => {
    const bridge = options.getBridge();
    if (!bridge) {
      pendingCacheSeq = Math.max(pendingCacheSeq ?? 0, seq);
      return;
    }
    const elements = bridge.getElements();
    await safe(() => cache.writeScene(state.boardId, elements, seq), undefined);
    state.cacheSeq = Math.max(state.cacheSeq ?? 0, seq);
    emit();
  };

  /** 本地/远端应用完成后 150ms 合并落盘，避免每个 op 都整板重写。 */
  const schedulePersist = (seq?: number) => {
    if (typeof seq === "number") persistSeq = Math.max(persistSeq ?? 0, seq);
    if (persistTimer !== null) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      const target = persistSeq ?? state.cacheSeq ?? 0;
      persistSeq = null;
      void persistSceneAndSeq(target);
    }, 150);
  };

  const submit = (ops: readonly ElementOp[]) => {
    if (ops.length === 0) return;
    if (!canWrite()) return;
    const batch: OpBatch = { boardId: state.boardId, clientId, ops: [...ops] };

    if (!state.joined || !socket) {
      void persistEnqueue(ops);
      // 断线期间的本地编辑也要进整板缓存：刷新首帧应包含它们，
      // 否则只能等重连补发 op 后才出现（C5 缓存先行的回归项）。
      schedulePersist();
      emit();
      return;
    }

    socket.submit(batch);
    state.submittedBatches += 1;
    state.submittedOps += batch.ops.length;
    // 先落盘再等 ack：刷新/关闭标签时，未 ack 的 op 仍在队列里，下次启动补发
    void persistEnqueue(ops);
    schedulePersist();
    emit();
  };

  const applyOne = (payload: ApplyPayload) => {
    const bridge = options.getBridge();
    if (!bridge) {
      pendingRemote.push(payload);
      state.deferredRemote += 1;
      emit();
      return;
    }

    const current = bridge.getElements();
    const index = current.findIndex((el) => el.id === payload.op.id);
    const local = index >= 0 ? current[index] : null;

    if (decideRemoteApply(local, payload.op) === "ignore") {
      state.ignoredRemote += 1;
      emit();
      return;
    }

    if (payload.op.kind === "upsert") {
      const incoming = { ...(payload.op.data as SceneElement) };
      // 以 op 的版本字段为准，避免 data 与 op 不一致
      incoming.id = payload.op.id;
      incoming.version = payload.op.version;
      incoming.versionNonce = payload.op.versionNonce;
      incoming.isDeleted = false;

      const next = index >= 0 ? current.map((el, i) => (i === index ? incoming : el)) : [...current, incoming];
      bridge.applyRemoteElements(next);
    } else {
      if (index < 0) {
        state.ignoredRemote += 1;
        emit();
        return;
      }
      bridge.applyRemoteElements(current.filter((_, i) => i !== index));
    }

    state.appliedRemote += 1;
    state.lastApplySeq = payload.seq;
    schedulePersist(payload.seq);
    emit();
  };

  const handleApply = (payload: ApplyPayload) => {
    // 本地指针按下时先排队，抬指后再应用，避免打断绘制
    if (pointerDown) {
      pendingRemote.push(payload);
      state.deferredRemote += 1;
      emit();
      return;
    }
    applyOne(payload);
  };

  const flushPending = () => {
    if (pointerDown) return;
    while (pendingRemote.length > 0) {
      const next = pendingRemote.shift();
      if (next) applyOne(next);
    }
  };

  const scheduleFlushPending = () => {
    if (flushTimer !== null) clearTimeout(flushTimer);
    // 让 Excalidraw 先处理完自己的 pointerup / 收尾，再回放远端
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushPending();
    }, 0);
  };

  const onPointerDown = () => {
    pointerDown = true;
  };
  const onPointerUp = () => {
    if (!pointerDown) return;
    pointerDown = false;
    scheduleFlushPending();
  };

  const toApplyPayload = (item: PulledOp): ApplyPayload => ({
    boardId: state.boardId,
    seq: item.seq,
    op: item.op,
    applied: true,
    stale: false,
    by: "pull",
  });

  const resyncFromSnapshot = async () => {
    state.resyncCount += 1;
    const snapshot = await fetchSnapshot(state.boardId);
    if (!snapshot.ok) {
      console.warn(`[collab] 快照重载失败 status=${snapshot.status} code=${snapshot.code}`);
      emit();
      return;
    }
    const elements = snapshot.data.elements as SceneElement[];
    const bridge = options.getBridge();
    if (bridge) bridge.applyRemoteElements(elements);
    else pendingReplace = elements;
    state.lastPullResync = true;
    await persistSceneAndSeq(snapshot.data.seq);
    state.synced = true;
    emit();
  };

  /** join 后用 `since = 本地缓存 seq` 补拉，直到追上服务端 `last_seq`。 */
  const syncFromServer = async (serverSeq: number) => {
    const cachedSeq = (await safe(() => cache.getSeq(state.boardId), null)) ?? 0;
    state.cacheSeq = cachedSeq;
    state.lastPullSince = cachedSeq;

    if (serverSeq <= cachedSeq) {
      state.synced = true;
      emit();
      return;
    }
    if (decideResync(cachedSeq, serverSeq)) {
      await resyncFromSnapshot();
      return;
    }

    let cursor = cachedSeq;
    let pulled = 0;
    for (let page = 0; page < MAX_PULL_PAGES; page += 1) {
      const res = await fetchOpsPage(state.boardId, cursor, LIMITS.opsPageMax);
      if (!res.ok) {
        console.warn(`[collab] 补拉失败 status=${res.status} code=${res.code} since=${cursor}`);
        break;
      }
      if (res.data.resync) {
        await resyncFromSnapshot();
        return;
      }
      for (const item of res.data.ops) {
        applyOne(toApplyPayload(item));
        pulled += 1;
      }
      state.pullPages += 1;
      cursor = res.data.nextSince;
      if (!res.data.hasMore || cursor >= res.data.lastSeq) break;
    }

    state.lastPullCount += pulled;
    await persistSceneAndSeq(cursor);
    state.synced = true;
    emit();
  };

  /** 把持久化队列按原顺序补发（服务端按 opId 幂等，重复提交不会产生重复 op）。 */
  const flushPersistedQueue = async () => {
    const queued = await safe(() => cache.listQueued(state.boardId), []);
    state.queuedOps = queued.length;
    if (queued.length === 0 || !socket) {
      emit();
      return;
    }

    for (let start = 0; start < queued.length; start += LIMITS.opBatchMax) {
      const chunk = queued.slice(start, start + LIMITS.opBatchMax);
      socket.submit({ boardId: state.boardId, clientId, ops: chunk.map((item) => item.op) });
      state.submittedBatches += 1;
      state.submittedOps += chunk.length;
    }
    emit();
  };

  const afterJoin = async (serverSeq: number) => {
    try {
      if (state.viewOnly) {
        await safe(() => cache.clearQueue(state.boardId), undefined);
        await refreshQueuedOps();
        await syncFromServer(serverSeq);
        return;
      }
      // 先补发本地未确认的 op，再拉远端；服务端 LWW 决定最终值
      await flushPersistedQueue();
      await syncFromServer(serverSeq);
    } catch (err) {
      console.warn("[collab] join 后同步失败", err);
    }
  };

  const handleJoined = (payload: JoinedPayload) => {
    state.joined = true;
    state.role = payload.self.role;
    state.identity = payload.self.identity;
    state.serverSeq = payload.seq;
    state.viewOnly = payload.self.viewOnly ?? payload.self.role === "viewer";
    state.synced = false;
    emit();
    void afterJoin(payload.seq);
  };

  const handleRejected = (payload: RejectedPayload) => {
    state.rejected.push(payload);
    if (state.rejected.length > MAX_REJECTIONS) state.rejected.shift();
    if (payload.reason === "NO_PERMISSION") {
      // 服务端判定只读：同步收回本地写权限与未发送队列
      state.viewOnly = true;
      state.role = "viewer";
      void safe(() => cache.clearQueue(state.boardId), undefined).then(refreshQueuedOps);
    } else if (payload.opId && !["NOT_JOINED", "IDEMPOTENT_IN_FLIGHT", "INTERNAL"].includes(payload.reason)) {
      // 终态拒绝：留在队列里只会无限重发
      markSettled(payload.opId);
    }
    emit();
  };

  const handleAck = (payload: AckPayload) => {
    state.lastAck = payload;
    state.staleIds = payload.stale;
    // op 已落库（含 duplicate），可以从待发队列删除
    markSettled(payload.opId);
    schedulePersist(payload.seq);
    if (payload.stale.length > 0) {
      // 服务端会把 LWW 胜者的 op:apply 广播给同 room（含自己），由下行 LWW 自动收敛
      console.warn(`[collab] op ${payload.opId} 被判 stale，等待胜者 op:apply 收敛：${payload.stale.join(",")}`);
    }
    emit();
  };

  /**
   * M3 presence：服务端已按用户聚合（`users[].connectionCount` 即标签页数）。
   * 连接断开时顺手清理它留下的光标，避免"幽灵光标"。
   */
  const handlePresence = (payload: PresenceStatePayload) => {
    state.presence = payload;
    const alive = new Set(payload.users.flatMap((user) => user.connectionIds));
    state.cursors = state.cursors.filter((cursor) => alive.has(cursor.connectionId));
    emit();
  };

  const handleCursor = (payload: CursorPayload) => {
    if (payload.boardId !== state.boardId) return;
    const next: RemoteCursor = { ...payload, at: Date.now() };
    const index = state.cursors.findIndex((cursor) => cursor.connectionId === payload.connectionId);
    if (index >= 0) {
      state.cursors = state.cursors.map((cursor, i) => (i === index ? next : cursor));
    } else {
      state.cursors = [...state.cursors, next].slice(-MAX_CURSORS);
    }
    emit();
  };

  /** 光标上行节流；坐标由页面按画布容器归一化到 0..1。 */
  const sendCursor = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const nowMs = Date.now();
    if (nowMs - lastCursorAt < CURSOR_INTERVAL_MS) return;
    lastCursorAt = nowMs;
    socket?.sendCursor(x, y);
  };

  return {
    snapshot: (): CollabSnapshot => ({
      ...state,
      staleIds: [...state.staleIds],
      rejected: [...state.rejected],
      cursors: [...state.cursors],
      presence: state.presence
        ? {
            ...state.presence,
            users: state.presence.users.map((user) => ({
              ...user,
              tabIds: [...user.tabIds],
              connectionIds: [...user.connectionIds],
            })),
          }
        : null,
    }),
    submit,
    sendCursor,
    /** 画布 API 就绪后调用，回放此前因无画布而积压的远端 op / 快照。 */
    notifyCanvasReady: () => {
      const bridge = options.getBridge();
      if (pendingReplace && bridge) {
        bridge.applyRemoteElements(pendingReplace);
        pendingReplace = null;
      }
      flushPending();
      if (pendingCacheSeq !== null) {
        const seq = pendingCacheSeq;
        pendingCacheSeq = null;
        void persistSceneAndSeq(seq);
      } else {
        schedulePersist();
      }
    },
    /** 手动再补拉一次（调试/验收用）。 */
    syncNow: () => {
      void syncFromServer(state.serverSeq ?? 0);
    },
    /** 调试入口：模拟断线（验收脚本用），不影响正常重连逻辑。 */
    debugDisconnect: () => socket?.disconnect(),
    debugConnect: () => socket?.connect(),
    start() {
      if (socket || stopped) return;
      window.addEventListener("pointerdown", onPointerDown, true);
      window.addEventListener("pointerup", onPointerUp, true);
      window.addEventListener("pointercancel", onPointerUp, true);

      socket = createBoardSocket({
        boardId: state.boardId,
        clientId,
        viewOnly: options.viewOnly,
        tabId: state.tabId,
        guestId: state.guestId,
        handlers: {
          onStatus: (status) => {
            state.status = status;
            if (status === "disconnected") {
              state.joined = false;
              state.synced = false;
            }
            emit();
          },
          onJoined: handleJoined,
          onJoinError: (code) => {
            console.warn(`[collab] join 失败：${code}`);
            emit();
          },
          onAck: handleAck,
          onApply: handleApply,
          onRejected: handleRejected,
          onPresence: handlePresence,
          onCursor: handleCursor,
        },
      });
      void refreshQueuedOps();
      // 画布可能已经就绪（collab 在场景加载后才创建）
      if (options.getBridge()) {
        flushPending();
        schedulePersist();
      }
      emit();
    },
    stop() {
      stopped = true;
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerUp, true);
      if (flushTimer !== null) clearTimeout(flushTimer);
      flushTimer = null;
      if (persistTimer !== null) {
        clearTimeout(persistTimer);
        persistTimer = null;
        void persistSceneAndSeq(persistSeq ?? state.cacheSeq ?? 0);
      }
      persistSeq = null;
      socket?.close();
      socket = null;
      pendingRemote.length = 0;
    },
  };
}
