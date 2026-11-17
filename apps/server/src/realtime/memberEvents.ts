import type { Namespace } from 'socket.io';
import type { AccessRole } from '../domain/access.js';

/**
 * 白板成员变更（角色变更 / 移出）的实时通知。
 *
 * 与 `boardBroadcast.ts` 同思路：REST 路由改完 `board_members` 后，通过这里把结果推到
 * 正在房间里的连接上，避免"改了角色但该用户还在用旧权限写"的窗口期。
 *
 * 两个事件：
 * - `member:role`：角色变了。发给整个房间（payload 带 identity，客户端按自己的身份过滤），
 *   同时每个实例把本实例上该用户连接的 `socket.data.role` 就地改掉——`op:submit`
 *   的权限判定读的就是它，因此下一次写入立即按新角色执行；**已提交的 op 不回滚**。
 * - `member:removed`：被移出。只发给该身份的连接，发完立即 `disconnect(true)`；
 *   不封禁，之后仍可通过重新被邀请或持有分享链接再次进入。
 *
 * 跨实例：
 * - `member:role` 用 `serverSideEmit` 让其它实例也更新本地 socket/presence（该事件不回到本实例，
 *   且服务端监听只接收 serverSideEmit，不会被客户端伪造）。
 * - `member:removed` 用 `fetchSockets()`（redis-adapter 支持跨实例）逐个 emit + disconnect。
 */

export const MEMBER_ROLE_EVENT = 'member:role';
export const MEMBER_REMOVED_EVENT = 'member:removed';

export type MemberRolePayload = {
  boardId: string;
  /** `user:<id>` / `guest:<id>`，与 presence 的 identity 同口径 */
  identity: string;
  role: AccessRole;
  at: number;
};

export type MemberRemovedPayload = {
  boardId: string;
  identity: string;
  at: number;
};

export type MemberNotifier = {
  roleChanged(boardId: string, identity: string, role: AccessRole): Promise<void>;
  removed(boardId: string, identity: string): Promise<void>;
};

export function createMemberNotifier(deps: {
  ns: Namespace;
  roomOf: (boardId: string) => string;
  /** 本实例就地更新：socket.data.role + 本地 presence 注册表 + ping 名单帧 */
  applyLocalRole: (boardId: string, identity: string, role: AccessRole) => void | Promise<void>;
}): MemberNotifier {
  return {
    async roleChanged(boardId, identity, role) {
      const payload: MemberRolePayload = { boardId, identity, role, at: Date.now() };
      await deps.applyLocalRole(boardId, identity, role);
      // 其它实例：各自更新本地 socket.data 与 presence，然后补一帧名单
      deps.ns.serverSideEmit(MEMBER_ROLE_EVENT, payload);
      deps.ns.to(deps.roomOf(boardId)).emit(MEMBER_ROLE_EVENT, payload);
    },

    async removed(boardId, identity) {
      const payload: MemberRemovedPayload = { boardId, identity, at: Date.now() };
      const sockets = await deps.ns.in(deps.roomOf(boardId)).fetchSockets();
      for (const socket of sockets) {
        const data = socket.data as { identity?: string } | undefined;
        if (data?.identity !== identity) continue;
        // 先告知再断开：客户端据此停止自动重连并提示"已被移出"，避免无意义的重连风暴
        socket.emit(MEMBER_REMOVED_EVENT, payload);
        socket.disconnect(true);
      }
    },
  };
}

/**
 * 模块级登记：实时层挂载时绑定，REST 路由按需取用。
 * 未挂载（单测 / 纯 REST）时为 null，落库已经生效，客户端下次 join 会重新判定权限。
 */
let notifier: MemberNotifier | null = null;

export function bindMemberNotifier(next: MemberNotifier | null): void {
  notifier = next;
}

export function memberNotifier(): MemberNotifier | null {
  return notifier;
}
