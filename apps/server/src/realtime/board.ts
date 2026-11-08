import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { LIMITS, opSubmitSchema } from '@whiteboard/shared';
import { config } from '../config.js';
import { logger } from '../infra/logger.js';
import { pool } from '../infra/db.js';
import { getBoardForJoin, persistOp } from './opStore.js';
import { allocateSeq, claimOpIdem, markOpIdemDone, releaseOpIdem } from './seq.js';
import { resolveJoinRole, type JoinRole } from '../domain/roles.js';

const joinSchema = z.object({
  boardId: z.string().regex(LIMITS.boardIdPattern),
  clientId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  /** M2-C4：只读客户端自报；只能把 editor 降为 viewer，不能提权。 */
  viewOnly: z.boolean().optional(),
});

type JoinPayload = z.infer<typeof joinSchema>;

type SocketState = {
  boardId: string;
  clientId: string;
  role: JoinRole;
  identity: string;
  guestId: string;
};

const stateOf = (socket: { data: Record<string, unknown> }): SocketState | null =>
  (socket.data as Partial<SocketState>).boardId ? (socket.data as SocketState) : null;

const roomOf = (boardId: string) => `board:${boardId}`;

const COLORS = ['#A85C7C', '#7C8AA8', '#5C9E7C', '#A88B5C', '#8A5CA8', '#5CA8A0'];
const colorOf = (seed: string) => COLORS[[...seed].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % COLORS.length] ?? COLORS[0];

/**
 * 挂载 Socket.IO `/board` namespace。
 *
 * 强制 `transports: ['websocket']`，避免 C1 部署里的轮询降级；
 * 广播通过 `@socket.io/redis-adapter` 扇出，双实例（8080/8081）才能互相收到。
 *
 * **鉴权缺口（如实标注）**：当前没有会话/OAuth 中间件，`join` 只能按"板存在且
 * `share_mode != private`"放行；`guestId` 由客户端 self-claim 的 `clientId` 派生，
 * 服务端未签名、未校验。真正的登录/游客 cookie 校验待 M1 补做。
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

  ns.on('connection', (socket) => {
    logger.debug({ sid: socket.id, instance: config.INSTANCE_ID }, 'socket connected');

    socket.on('join', async (payload: unknown, ack?: (res: unknown) => void) => {
      const parsed = joinSchema.safeParse(payload);
      if (!parsed.success) {
        socket.emit('join:error', { code: 'INVALID_INPUT', issues: parsed.error.issues });
        ack?.({ ok: false, code: 'INVALID_INPUT' });
        return;
      }

      const { boardId, clientId, viewOnly = false }: JoinPayload = parsed.data;

      try {
        const board = await getBoardForJoin(boardId);
        if (!board || board.archived_at) {
          socket.emit('join:error', { code: 'NOT_FOUND' });
          ack?.({ ok: false, code: 'NOT_FOUND' });
          return;
        }
        // 最小规则：没有鉴权前，private 板（包括未登录 owner 自己的板）一律不可进
        const role = resolveJoinRole(board.share_mode, viewOnly);
        if (role === 'forbidden') {
          socket.emit('join:error', { code: 'FORBIDDEN' });
          ack?.({ ok: false, code: 'FORBIDDEN' });
          return;
        }

        const guestId = `anon_${clientId}`;
        const identity = `guest:${guestId}`;

        const state: SocketState = { boardId, clientId, role, identity, guestId };
        socket.data = state;
        await socket.join(roomOf(boardId));

        const joined = {
          self: { identity, role, isGuest: true, color: colorOf(guestId), viewOnly: role === 'viewer' },
          seq: board.last_seq,
          resumed: false,
        };
        socket.emit('joined', joined);
        ack?.({ ok: true, ...joined });
        logger.info({ instance: config.INSTANCE_ID, boardId, clientId, role }, 'socket joined board');
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
      if (state.role !== 'editor') {
        for (const op of batch.ops) socket.emit('op:rejected', { opId: op.opId, reason: 'NO_PERMISSION' });
        return;
      }
      if (Buffer.byteLength(JSON.stringify(batch.ops), 'utf8') > LIMITS.opPayloadBytes) {
        socket.emit('op:rejected', { opId: null, reason: 'PAYLOAD_TOO_LARGE' });
        return;
      }

      let seed = 0;
      try {
        const { rows } = await pool.query<{ last_seq: string }>('select last_seq from boards where id = $1', [state.boardId]);
        seed = Number(rows[0]?.last_seq ?? 0);
      } catch (err) {
        logger.error({ err: err instanceof Error ? err.message : String(err) }, 'read board last_seq failed');
        socket.emit('op:rejected', { opId: null, reason: 'INTERNAL' });
        return;
      }

      for (const op of batch.ops) {
        try {
          const claim = await claimOpIdem(state.boardId, op.opId);
          if (claim.kind === 'done') {
            socket.emit('op:ack', { opId: op.opId, seq: claim.seq, stale: [], duplicate: true });
            continue;
          }
          if (claim.kind === 'in-flight') {
            socket.emit('op:rejected', { opId: op.opId, reason: 'IDEMPOTENT_IN_FLIGHT' });
            continue;
          }

          const seq = await allocateSeq(state.boardId, seed);
          let result: { applied: boolean; stale: boolean };
          try {
            result = await persistOp({
              boardId: state.boardId,
              clientId: state.clientId,
              guestId: state.guestId,
              seq,
              op,
            });
          } catch (err) {
            await releaseOpIdem(state.boardId, op.opId).catch(() => undefined);
            throw err;
          }

          await markOpIdemDone(state.boardId, op.opId, seq);

          socket.emit('op:ack', {
            opId: op.opId,
            seq,
            stale: result.stale ? [op.id] : [],
            duplicate: false,
            applied: result.applied,
          });

          // 包括发送者在内容：同 room 的所有连接都会收到；客户端按 opId 幂等应用
          ns.to(roomOf(state.boardId)).emit('op:apply', {
            boardId: state.boardId,
            seq,
            op,
            applied: result.applied,
            stale: result.stale,
            by: state.identity,
          });

          logger.info(
            { instance: config.INSTANCE_ID, boardId: state.boardId, opId: op.opId, seq, applied: result.applied, stale: result.stale },
            'op persisted',
          );
        } catch (err) {
          logger.error({ err: err instanceof Error ? err.message : String(err), opId: op.opId }, 'op:submit failed');
          socket.emit('op:rejected', { opId: op.opId, reason: 'INTERNAL' });
        }
      }
    });

    socket.on('disconnect', (reason) => {
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
