import type { ElementOp, OpBatch } from "@whiteboard/shared";
import { decideRemoteApply } from "./lww";
import { createOutbox } from "./outbox";
import {
  createBoardSocket,
  type AckPayload,
  type ApplyPayload,
  type BoardSocket,
  type ConnectionStatus,
  type JoinRole,
  type JoinedPayload,
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

export type CollabSnapshot = {
  boardId: string;
  clientId: string;
  status: ConnectionStatus;
  joined: boolean;
  role: JoinRole | "unknown";
  viewOnly: boolean;
  identity: string | null;
  serverSeq: number | null;
  submittedBatches: number;
  submittedOps: number;
  queuedBatches: number;
  droppedBatches: number;
  appliedRemote: number;
  ignoredRemote: number;
  deferredRemote: number;
  lastApplySeq: number | null;
  lastAck: AckPayload | null;
  staleIds: string[];
  rejected: RejectedPayload[];
};

export type BoardCollab = ReturnType<typeof createBoardCollab>;

const MAX_REJECTIONS = 20;

/**
 * M2-C4 协作控制器：
 *
 * - 上行：`BoardCanvas` 派生出的 op 交给 `submit`；断线时进 `outbox`，重连 `joined` 后补发。
 * - 下行：收到 `op:apply` 先按 LWW 判定本地是否被覆盖，再交给 `CanvasBridge`，
 *   内部用 `updateScene({ captureUpdate: NEVER })` 回放，远端改动不进本地撤销栈。
 * - 本地指针按下期间远端 op 先排队，抬指后再应用，避免打断正在进行的绘制。
 * - viewer 不产 op；服务端仍然独立拒绝写（见 server `resolveJoinRole`）。
 */
export function createBoardCollab(options: {
  boardId: string;
  viewOnly: boolean;
  clientId?: string;
  getBridge: () => CanvasBridge | null;
  onChange?: (snapshot: CollabSnapshot) => void;
}) {
  const clientId = options.clientId ?? `web_${globalThis.crypto.randomUUID().slice(0, 13)}`;

  const state: CollabSnapshot = {
    boardId: options.boardId,
    clientId,
    status: "connecting",
    joined: false,
    role: "unknown",
    viewOnly: options.viewOnly,
    identity: null,
    serverSeq: null,
    submittedBatches: 0,
    submittedOps: 0,
    queuedBatches: 0,
    droppedBatches: 0,
    appliedRemote: 0,
    ignoredRemote: 0,
    deferredRemote: 0,
    lastApplySeq: null,
    lastAck: null,
    staleIds: [],
    rejected: [],
  };

  const outbox = createOutbox({
    max: 100,
    onDrop: () => {
      state.droppedBatches += 1;
      console.warn("[collab] 断线队列超出上限，丢弃最旧批次；远端可能需要 C5 的整板补拉");
      emit();
    },
  });

  const pendingRemote: ApplyPayload[] = [];
  let pointerDown = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let socket: BoardSocket | null = null;
  let stopped = false;

  const emit = () => {
    state.queuedBatches = outbox.size();
    options.onChange?.({ ...state, staleIds: [...state.staleIds], rejected: [...state.rejected] });
  };

  const canWrite = () => {
    if (state.viewOnly) return false;
    if (state.role === "viewer") return false;
    // 尚未 joined 时不阻断：op 先进 outbox，等拿到角色后再决定发送或丢弃
    return true;
  };

  const submit = (ops: readonly ElementOp[]) => {
    if (ops.length === 0) return;
    if (!canWrite()) return;
    const batch: OpBatch = { boardId: state.boardId, clientId, ops: [...ops] };
    if (!state.joined || !socket) {
      outbox.push(batch);
      emit();
      return;
    }
    socket.submit(batch);
    state.submittedBatches += 1;
    state.submittedOps += batch.ops.length;
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

  const handleJoined = (payload: JoinedPayload) => {
    state.joined = true;
    state.role = payload.self.role;
    state.identity = payload.self.identity;
    state.serverSeq = payload.seq;
    state.viewOnly = payload.self.viewOnly ?? payload.self.role === "viewer";

    if (state.viewOnly) {
      outbox.clear();
    } else {
      const queued = outbox.drain();
      if (socket) for (const batch of queued) socket.submit(batch);
      state.submittedBatches += queued.length;
      state.submittedOps += queued.reduce((sum, batch) => sum + batch.ops.length, 0);
    }
    emit();
  };

  const handleRejected = (payload: RejectedPayload) => {
    state.rejected.push(payload);
    if (state.rejected.length > MAX_REJECTIONS) state.rejected.shift();
    if (payload.reason === "NO_PERMISSION") {
      // 服务端判定只读：同步收回本地写权限与未发送队列
      state.viewOnly = true;
      state.role = "viewer";
      outbox.clear();
    }
    emit();
  };

  const handleAck = (payload: AckPayload) => {
    state.lastAck = payload;
    state.staleIds = payload.stale;
    if (payload.stale.length > 0) {
      // C4 不做额外拉取：服务端会把 LWW 胜者的 op:apply 广播给同 room（含自己），
      // 由下行 LWW 自动收敛；整板补拉留给 C5。
      console.warn(`[collab] op ${payload.opId} 被判 stale，等待胜者 op:apply 收敛：${payload.stale.join(",")}`);
    }
    emit();
  };

  return {
    snapshot: (): CollabSnapshot => ({
      ...state,
      staleIds: [...state.staleIds],
      rejected: [...state.rejected],
    }),
    submit,
    /** 画布 API 就绪后调用，回放此前因无画布而积压的远端 op。 */
    notifyCanvasReady: () => {
      flushPending();
    },
    start() {
      if (socket || stopped) return;
      window.addEventListener("pointerdown", onPointerDown, true);
      window.addEventListener("pointerup", onPointerUp, true);
      window.addEventListener("pointercancel", onPointerUp, true);

      socket = createBoardSocket({
        boardId: state.boardId,
        clientId,
        viewOnly: options.viewOnly,
        handlers: {
          onStatus: (status) => {
            state.status = status;
            if (status === "disconnected") state.joined = false;
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
        },
      });
      emit();
    },
    stop() {
      stopped = true;
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerUp, true);
      if (flushTimer !== null) clearTimeout(flushTimer);
      flushTimer = null;
      socket?.close();
      socket = null;
      pendingRemote.length = 0;
    },
  };
}
