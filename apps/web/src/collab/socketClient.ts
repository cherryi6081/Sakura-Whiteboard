import { io, type Socket } from "socket.io-client";
import type { ElementOp, OpBatch } from "@whiteboard/shared";

/**
 * M2-C4：`/board` 命名空间的浏览器客户端。
 *
 * 连接地址不写死：走同源（开发期由 `vite.config.ts` 把 `/socket.io` 代理到
 * `VITE_API_TARGET`），生产环境由反向代理同源转发。
 *
 * 只做传输层：join/重连、事件回调、submit。合并与 LWW 在 `BoardCollab` 里。
 */

export type JoinRole = "editor" | "viewer";

export type JoinedPayload = {
  self: { identity: string; role: JoinRole; isGuest: boolean; color: string; viewOnly?: boolean };
  seq: number;
  resumed: boolean;
};

export type AckPayload = {
  opId: string;
  seq: number;
  stale: string[];
  duplicate: boolean;
  applied: boolean;
};

export type ApplyPayload = {
  boardId: string;
  seq: number;
  op: ElementOp;
  applied: boolean;
  stale: boolean;
  by: string;
};

export type RejectedPayload = {
  opId: string | null;
  reason: string;
  issues?: unknown;
};

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export type BoardSocketHandlers = {
  onStatus: (status: ConnectionStatus) => void;
  onJoined: (payload: JoinedPayload) => void;
  onJoinError: (code: string) => void;
  onAck: (payload: AckPayload) => void;
  onApply: (payload: ApplyPayload) => void;
  onRejected: (payload: RejectedPayload) => void;
};

export type BoardSocket = {
  socket: Socket;
  submit: (batch: OpBatch) => void;
  /** 调试/验收用：手动断开（会关闭自动重连），重新 `connect()` 后 join 会再次执行。 */
  disconnect: () => void;
  connect: () => void;
  close: () => void;
};

export function createBoardSocket(options: {
  boardId: string;
  clientId: string;
  viewOnly: boolean;
  handlers: BoardSocketHandlers;
}): BoardSocket {
  const { boardId, clientId, viewOnly, handlers } = options;

  // 同源连接；namespace 固定 `/board`
  const socket = io("/board", {
    transports: ["websocket"],
    reconnection: true,
    reconnectionDelay: 600,
    reconnectionDelayMax: 4000,
    timeout: 8000,
    auth: { boardId, clientId, viewOnly },
  });

  const join = () => {
    socket.emit("join", { boardId, clientId, viewOnly }, (res: { ok?: boolean; code?: string } | undefined) => {
      if (!res?.ok) handlers.onJoinError(res?.code ?? "INTERNAL");
    });
  };

  socket.on("connect", () => {
    handlers.onStatus("connected");
    // 首次连接与每次自动重连都要重新 join（服务端 room 成员随 socket 生命周期）
    join();
  });
  socket.on("disconnect", () => handlers.onStatus("disconnected"));
  socket.on("connect_error", () => handlers.onStatus("disconnected"));

  socket.on("joined", handlers.onJoined);
  socket.on("join:error", (payload: { code?: string } | undefined) => handlers.onJoinError(payload?.code ?? "INTERNAL"));
  socket.on("op:ack", handlers.onAck);
  socket.on("op:apply", handlers.onApply);
  socket.on("op:rejected", handlers.onRejected);

  return {
    socket,
    submit(batch) {
      socket.emit("op:submit", batch);
    },
    disconnect() {
      socket.disconnect();
    },
    connect() {
      socket.connect();
    },
    close() {
      socket.removeAllListeners();
      socket.disconnect();
    },
  };
}
