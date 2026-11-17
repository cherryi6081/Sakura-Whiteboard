import type { Namespace } from 'socket.io';

/**
 * REST → Socket.IO 的单向广播桥。
 *
 * 实时层由 `attachRealtime` 持有 `/board` namespace；少量 HTTP 写路径（目前只有
 * 公共临时板清空）也需要把结果按正常下行事件推给房间内客户端，因此在这里登记
 * 一个 namespace 引用，避免路由与实时层互相 import 造成循环依赖。
 *
 * 未挂载实时层（单测、纯 REST 环境）时静默跳过：落库已经完成，客户端下次 join
 * 补拉同样能拿到结果。
 */

let boardNamespace: Namespace | null = null;

export function bindBoardNamespace(ns: Namespace | null): void {
  boardNamespace = ns;
}

export function broadcastToBoard(boardId: string, event: string, payload: unknown): void {
  boardNamespace?.to(`board:${boardId}`).emit(event, payload as never);
}
