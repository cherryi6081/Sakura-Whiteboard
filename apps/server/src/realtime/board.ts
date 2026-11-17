import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { LIMITS, opSubmitSchema } from '@whiteboard/shared';
import { config } from '../config.js';
import { logger } from '../infra/logger.js';
import { pool } from '../infra/db.js';
import { createWriteBatcher } from './opBatcher.js';
import { resolveBoardAccess, type AccessRole } from '../domain/access.js';
import { resolveIdentityFromCookieHeader, type Identity } from '../auth/identity.js';
import { createPresenceRegistry } from './presence.js';
import { createPresenceFanout } from './presenceFanout.js';
import { createCursorFanout } from './cursorFanout.js';
import { cursorColorOf } from './cursorPalette.js';

const joinSchema = z.object({
  boardId: z.string().regex(LIMITS.boardIdPattern),
  clientId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  /** M2-C4：只读客户端自报；只能降级，不能提权。 */
  viewOnly: z.boolean().optional(),
  /**
   * M5-1 起**不再接受**客户端自报 `guestId`：身份只从 WS 握手带的签名 cookie / Redis
   * 会话推导。`tabId` 仍来自 sessionStorage，只用于 presence 展示与重复检测。
   */
  tabId: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
  /**
   * M5-2：分享链接的明文 token。仅用于"匿名凭链接进入"，服务端按
   * `share_links(token_hash)` 判定只读/可编辑、过期与吊销；它永远不能提权 owner。
   */
  shareToken: z.string().min(8).max(128).optional(),
});

type JoinPayload = z.infer<typeof joinSchema>;

/** M3：归一化光标坐标（0..1），越界/非有限值直接丢弃。 */
const cursorSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  /** 客户端诊断时间戳（压测用），原样回带；生产客户端不发送 */
  t: z.number().finite().nonnegative().optional(),
});

type SocketState = {
  boardId: string;
  clientId: string;
  tabId: string | null;
  role: AccessRole;
  identity: string;
  /** 展示用昵称（登录用户取 `users.display_name`，游客「游客」），随光标一起广播 */
  displayName: string;
  userId: string | null;
  guestId: string | null;
};

const stateOf = (socket: { data: Record<string, unknown> }): SocketState | null =>
  (socket.data as Partial<SocketState>).boardId ? (socket.data as SocketState) : null;

const roomOf = (boardId: string) => `board:${boardId}`;

/**
 * 挂载 Socket.IO `/board` namespace。
 *
 * 强制 `transports: ['websocket']`，避免 C1 部署里的轮询降级；
 * 广播通过 `@socket.io/redis-adapter` 扇出，双实例（8080/8081）才能互相收到。
 *
 * 身份**只从 WS 握手附带的签名 cookie / Redis 会话推导**（M5-1 收口）：
 * `join` 与 `op:submit` 都不再接受客户端自报的 `guestId`；`viewOnly` 只能降级权限。
 */
export function attachRealtime(httpServer: HttpServer) {
  const io = new Server(httpServer, {
    transports: ['websocket'],
    serveClient: false,
  });

  const pub = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const sub = pub.duplicate();
  const logRedisError = (who: string) => (err: Error) => logger.warn({ err: err.message, who }, 'socket.io redis adapter error');
  pub.on('error', logRedisError('pub'));
  sub.on('error', logRedisError('sub'));
  io.adapter(createAdapter(pub, sub));

  const ns = io.of('/board');
  /** M3：单实例内存 presence（多实例聚合不完整，见 presence.ts 顶部说明） */
  const presence = createPresenceRegistry();
  /**
   * 名单合帧：join/leave 只标记脏，100ms 内聚合成一帧广播。
   * 原来每次 join 都向房间内 N 个 socket 各写一份全量名单，N 人进房是 O(N²) 写入，
   * 直接把 join p95 拖到秒级；合帧后广播次数与人数解耦，且移出 join 响应路径。
   */
  const presenceFanout = createPresenceFanout(
    (boardId) => presence.state(boardId),
    (state) => ns.to(roomOf(state.boardId)).emit('presence:state', state),
  );
  /** 写路径攒批：同一块板的 op 合并进一个事务，减少事务数与板级锁竞争 */
  const writeBatcher = createWriteBatcher();
  /** 光标合帧：同一房间的光标合并成一条消息，帧间隔按活跃连接数在 14/24/33ms 间自适应（带迟滞） */
  const cursorFanout = createCursorFanout((boardId, cursors) => {
    ns.to(roomOf(boardId)).emit('presence:cursor:frame', { boardId, cursors, at: Date.now() });
  });

  ns.on('connection', (socket) => {
    logger.debug({ sid: socket.id, instance: config.INSTANCE_ID }, 'socket connected');

    socket.on('join', async (payload: unknown, ack?: (res: unknown) => void) => {
      const parsed = joinSchema.safeParse(payload);
      if (!parsed.success) {
        socket.emit('join:error', { code: 'INVALID_INPUT', issues: parsed.error.issues });
        ack?.({ ok: false, code: 'INVALID_INPUT' });
        return;
      }

      const { boardId, clientId, viewOnly = false, tabId: claimedTabId, shareToken }: JoinPayload = parsed.data;
      // z.optional() 解构默认值会与 `string | undefined` 冲突，这里统一收敛成 `string | null`
      const tabId = claimedTabId ?? null;

      try {
        // 身份只来自握手 cookie；客户端 payload 里即使塞了 guestId 也会被 schema 忽略/拒绝
        const identity: Identity = await resolveIdentityFromCookieHeader(socket.handshake.headers.cookie);
        const access = await resolveBoardAccess(boardId, identity, shareToken);
        if (!access.ok) {
          const code = access.reason === 'not_found' ? 'NOT_FOUND' : 'FORBIDDEN';
          socket.emit('join:error', { code });
          ack?.({ ok: false, code });
          return;
        }

        // 自报 viewOnly 只能降级；owner/editor 降为 viewer，viewer 不变
        const role: AccessRole = viewOnly && access.role !== 'viewer' ? 'viewer' : access.role;

        // 无 cookie 的直连客户端：由服务端生成临时身份（不是客户端自报），保证 op 归属可写
        const userId = identity.userId;
        const guestId = userId ? null : (identity.guestId ?? `anon_${socket.id}`);
        const presenceIdentity = userId ? `user:${userId}` : `guest:${guestId}`;

        // 昵称与头像只在 join 时查一次：登录用户取 users.display_name / avatar_url，游客为「游客」
        const profile = userId
          ? (await pool.query<{ display_name: string | null; avatar_url: string | null }>(
              'select display_name, avatar_url from users where id = $1',
              [userId],
            )).rows[0]
          : undefined;
        const displayName = profile?.display_name?.trim() || (userId ? '用户' : '游客');
        const avatarUrl = profile?.avatar_url ?? null;
        const color = cursorColorOf(userId ?? guestId ?? clientId);

        const state: SocketState = {
          boardId,
          clientId,
          tabId,
          role,
          identity: presenceIdentity,
          displayName,
          userId,
          guestId,
        };
        socket.data = state;
        await socket.join(roomOf(boardId));

        // 先登记 presence，再发 joined，保证客户端收到的第一条 presence 里包含自己
        const presenceState = presence.join({
          boardId,
          connectionId: socket.id,
          clientId,
          tabId,
          identity: presenceIdentity,
          role,
          color,
          displayName,
          avatarUrl,
          joinedAt: Date.now(),
        });

        const joined = {
          self: {
            // 合帧后光标会广播给整个房间（含发送者），客户端用它过滤掉自己
            connectionId: socket.id,
            identity: presenceIdentity,
            role,
            isGuest: !userId,
            color,
            displayName,
            avatarUrl,
            viewOnly: role === 'viewer',
            tabId,
          },
          seq: access.board.last_seq,
          resumed: false,
        };
        socket.emit('joined', joined);
        ack?.({ ok: true, ...joined });
        // 名单走合帧：本次 join 只标脏，所有人（含自己）在 ≤100ms 的下一帧拿到最新全量名单，
        // 不再在 join 响应路径里做 O(N) 扇出
        presenceFanout.touch(boardId);
        logger.info(
          { instance: config.INSTANCE_ID, boardId, clientId, tabId, role, totalConnections: presenceState.totalConnections },
          'socket joined board',
        );
      } catch (err) {
        logger.error({ err: err instanceof Error ? err.message : String(err), boardId }, 'join failed');
        socket.emit('join:error', { code: 'INTERNAL' });
        ack?.({ ok: false, code: 'INTERNAL' });
      }
    });

    socket.on('op:submit', async (payload: unknown) => {
      const state = stateOf(socket);
      if (!state) {
        socket.emit('op:rejected', { opId: null, reason: 'NOT_JOINED' });
        return;
      }

      const parsed = opSubmitSchema.safeParse(payload);
      if (!parsed.success) {
        socket.emit('op:rejected', { opId: null, reason: 'INVALID_INPUT', issues: parsed.error.issues });
        return;
      }

      const batch = parsed.data;
      if (batch.boardId !== state.boardId) {
        socket.emit('op:rejected', { opId: null, reason: 'FORBIDDEN' });
        return;
      }
      if (state.role !== 'owner' && state.role !== 'editor') {
        for (const op of batch.ops) socket.emit('op:rejected', { opId: op.opId, reason: 'NO_PERMISSION' });
        return;
      }
      if (Buffer.byteLength(JSON.stringify(batch.ops), 'utf8') > LIMITS.opPayloadBytes) {
        socket.emit('op:rejected', { opId: null, reason: 'PAYLOAD_TOO_LARGE' });
        return;
      }

      // 入队是同步的：同一连接的多条 op:submit 按到达顺序进入同一条板级队列，
      // 由 opBatcher 合并成更少的事务；seq 在同一队列内按入队顺序分配。
      const writes = batch.ops.map((op) =>
        writeBatcher.submit({
          boardId: state.boardId,
          clientId: state.clientId,
          userId: state.userId,
          guestId: state.guestId,
          op,
        }),
      );

      // 按原顺序回包：ack 与 op:apply 的先后跟 op 提交顺序一致
      for (const [index, op] of batch.ops.entries()) {
        // `writes` 与 `batch.ops` 同步生成，下标一定存在
        const outcome = await writes[index]!;

        if (outcome.kind === 'duplicate') {
          socket.emit('op:ack', { opId: outcome.opId, seq: outcome.seq, stale: [], duplicate: true });
          continue;
        }
        if (outcome.kind === 'rejected') {
          socket.emit('op:rejected', { opId: outcome.opId, reason: outcome.reason });
          continue;
        }

        socket.emit('op:ack', {
          opId: outcome.opId,
          seq: outcome.seq,
          stale: outcome.stale ? [op.id] : [],
          duplicate: false,
          applied: outcome.applied,
        });

        // 包括发送者在内容：同 room 的所有连接都会收到；客户端按 opId 幂等应用
        ns.to(roomOf(state.boardId)).emit('op:apply', {
          boardId: state.boardId,
          seq: outcome.seq,
          op,
          applied: outcome.applied,
          stale: outcome.stale,
          by: state.identity,
        });

        logger.info(
          {
            instance: config.INSTANCE_ID,
            boardId: state.boardId,
            opId: outcome.opId,
            seq: outcome.seq,
            applied: outcome.applied,
            stale: outcome.stale,
          },
          'op persisted',
        );
      }
    });

    /**
     * M3：光标按**连接**广播（不回显发送者）。坐标是画布容器内的归一化 0..1，
     * 不同标签视口不同，因此不能按用户合并成一个位置。
     */
    socket.on('cursor:move', (payload: unknown) => {
      const state = stateOf(socket);
      if (!state) return;
      const parsed = cursorSchema.safeParse(payload);
      if (!parsed.success) return;
      const conn = presence.moveCursor(state.boardId, socket.id, parsed.data.x, parsed.data.y);
      if (!conn) return;
      // 不回显发送者是靠客户端按 self.connectionId 过滤；这里统一走合帧，每帧一条消息
      cursorFanout.push(state.boardId, {
        connectionId: socket.id,
        clientId: state.clientId,
        tabId: state.tabId,
        identity: state.identity,
        color: conn.color,
        // 方案 A：昵称 + 加入时间随光标下发；前端按颜色分组、按 joinedAt 稳定排序后加序号
        displayName: conn.displayName,
        joinedAt: conn.joinedAt,
        x: parsed.data.x,
        y: parsed.data.y,
        ...(parsed.data.t === undefined ? {} : { t: parsed.data.t }),
      });
    });

    socket.on('disconnect', (reason) => {
      const state = stateOf(socket);
      if (state) {
        cursorFanout.drop(state.boardId, socket.id);
        const presenceState = presence.leave(state.boardId, socket.id);
        // 注册表已同步移除该连接，下一帧名单自然不再包含它（≤100ms），不留幽灵
        presenceFanout.touch(state.boardId);
        logger.debug(
          { instance: config.INSTANCE_ID, boardId: state.boardId, clientId: state.clientId, reason, remaining: presenceState.totalConnections },
          'socket left board',
        );
      }
      logger.debug({ sid: socket.id, reason }, 'socket disconnected');
    });
  });

  return {
    io,
    async close() {
      await new Promise<void>((resolve) => io.close(() => resolve()));
      await Promise.allSettled([pub.quit(), sub.quit()]);
    },
  };
}
