#!/usr/bin/env node
/**
 * M2-C3 端到端验收脚本（真实 Redis + PG，不使用内存替身）。
 *
 * 用法：
 *   node apps/server/scripts/verify-c3.mjs reset
 *   node apps/server/scripts/verify-c3.mjs idem
 *   node apps/server/scripts/verify-c3.mjs lww
 *   node apps/server/scripts/verify-c3.mjs seq
 *   node apps/server/scripts/verify-c3.mjs broadcast 8080 8081
 *   node apps/server/scripts/verify-c3.mjs dump
 *
 * 环境变量：DATABASE_URL / REDIS_URL / BASE_URL（默认 http://127.0.0.1:8080）
 */

import { io } from 'socket.io-client';
import pg from 'pg';
import { Redis } from 'ioredis';

const BOARD_ID = 'c3board00001';
const USER_ID = '00000000-0000-4000-8000-000000000001';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/whiteboard';
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';

const db = new pg.Client({ connectionString: databaseUrl.replace('localhost', '127.0.0.1') });

function op(kind, id, version, versionNonce, opId, type = 'rectangle') {
  const base = { opId, kind, id, type, baseVersion: version > 1 ? version - 1 : null, version, versionNonce };
  if (kind === 'delete') return { ...base, baseVersion: version - 1 };
  return {
    ...base,
    data: { id, type, version, versionNonce, isDeleted: false, x: 10, y: 10, width: 60, height: 40 },
    zindexKey: `a${id}`,
  };
}

function connect(baseUrl, clientId) {
  const socket = io(`${baseUrl}/board`, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`connect timeout: ${baseUrl}`)), 10_000);
    socket.on('connect', () => {
      socket.emit('join', { boardId: BOARD_ID, clientId }, (res) => {
        clearTimeout(timer);
        if (!res?.ok) reject(new Error(`join failed: ${JSON.stringify(res)}`));
        else resolve(socket);
      });
    });
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

const once = (socket, event, predicate = () => true, timeoutMs = 10_000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timeout waiting ${event}`));
    }, timeoutMs);
    const handler = (payload) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });

async function reset() {
  await db.query('delete from board_ops where board_id = $1', [BOARD_ID]);
  await db.query('delete from elements where board_id = $1', [BOARD_ID]);
  await db.query(
    `insert into users (id, display_name) values ($1, 'C3 验收用户')
     on conflict (id) do nothing`,
    [USER_ID],
  );
  await db.query(
    `insert into boards (id, title, owner_id, share_mode, last_seq)
     values ($1, 'C3 验收板', $2, 'link_edit', 0)
     on conflict (id) do update set share_mode = 'link_edit', last_seq = 0`,
    [BOARD_ID, USER_ID],
  );
  const redis = new Redis(redisUrl);
  await redis.del(`seq:${BOARD_ID}`);
  await redis.quit();
  console.log(`[reset] board=${BOARD_ID} 已清空 board_ops/elements 并重置 seq 键`);
}

async function dump() {
  const ops = await db.query(
    `select seq, op_id, kind, element_id, payload->>'version' as version
       from board_ops where board_id = $1 order by seq`,
    [BOARD_ID],
  );
  const els = await db.query(
    `select element_id, type, version, version_nonce, is_deleted, zindex_key
       from elements where board_id = $1 order by element_id`,
    [BOARD_ID],
  );
  const board = await db.query('select id, share_mode, last_seq from boards where id = $1', [BOARD_ID]);
  console.log('[dump] boards:', JSON.stringify(board.rows));
  console.log(`[dump] board_ops (${ops.rowCount} 行):`, JSON.stringify(ops.rows));
  console.log(`[dump] elements (${els.rowCount} 行):`, JSON.stringify(els.rows));
}

async function idem() {
  const url = process.env.BASE_URL ?? 'http://127.0.0.1:8080';
  const socket = await connect(url, 'idem-client');
  const before = await db.query('select count(*)::int as n from board_ops where board_id = $1', [BOARD_ID]);
  const element = op('upsert', 'el-idem', 1, 7, 'op-idem-fixed');
  console.log(`[idem] 提交前 board_ops=${before.rows[0].n}`);

  socket.emit('op:submit', { boardId: BOARD_ID, clientId: 'idem-client', ops: [element] });
  const first = await once(socket, 'op:ack', (p) => p.opId === 'op-idem-fixed');
  console.log('[idem] 第一次 op:ack =', JSON.stringify(first));

  socket.emit('op:submit', { boardId: BOARD_ID, clientId: 'idem-client', ops: [element] });
  const second = await once(socket, 'op:ack', (p) => p.opId === 'op-idem-fixed');
  console.log('[idem] 第二次 op:ack =', JSON.stringify(second));

  const after = await db.query('select count(*)::int as n from board_ops where board_id = $1', [BOARD_ID]);
  const el = await db.query(
    'select element_id, version, version_nonce, is_deleted from elements where board_id = $1 and element_id = $2',
    [BOARD_ID, 'el-idem'],
  );
  console.log(`[idem] 提交后 board_ops=${after.rows[0].n}（增量 ${after.rows[0].n - before.rows[0].n}）`);
  console.log('[idem] elements =', JSON.stringify(el.rows));
  socket.close();
}

async function lww() {
  const url = process.env.BASE_URL ?? 'http://127.0.0.1:8080';
  const a = await connect(url, 'lww-a');
  const b = await connect(url, 'lww-b');

  const high = op('upsert', 'el-lww', 12, 30, 'op-lww-high');
  const low = op('upsert', 'el-lww', 10, 31, 'op-lww-low');

  a.emit('op:submit', { boardId: BOARD_ID, clientId: 'lww-a', ops: [high] });
  // 先让高版本落库，再发低版本，确保"落后一方"确定性地收到 stale
  const highAck = await once(a, 'op:ack', (p) => p.opId === 'op-lww-high');
  console.log('[lww] 高版本 ack =', JSON.stringify(highAck));

  b.emit('op:submit', { boardId: BOARD_ID, clientId: 'lww-b', ops: [low] });
  const lowAck = await once(b, 'op:ack', (p) => p.opId === 'op-lww-low');
  console.log('[lww] 低版本 ack =', JSON.stringify(lowAck));

  const el = await db.query(
    'select element_id, version, version_nonce, is_deleted from elements where board_id = $1 and element_id = $2',
    [BOARD_ID, 'el-lww'],
  );
  console.log('[lww] 库里最终元素 =', JSON.stringify(el.rows));
  a.close();
  b.close();
}

async function seq() {
  const url = process.env.BASE_URL ?? 'http://127.0.0.1:8080';
  const socket = await connect(url, 'seq-client');
  const seqs = [];

  for (let i = 1; i <= 5; i += 1) {
    const payload = op('upsert', `el-seq-${i}`, 1, i, `op-seq-${i}`);
    socket.emit('op:submit', { boardId: BOARD_ID, clientId: 'seq-client', ops: [payload] });
    const ack = await once(socket, 'op:ack', (p) => p.opId === `op-seq-${i}`);
    seqs.push(ack.seq);
  }

  const monotonic = seqs.every((v, i) => i === 0 || v > seqs[i - 1]);
  console.log('[seq] 连续分配的 seq =', JSON.stringify(seqs), `严格单调=${monotonic}`);
  socket.close();
}

async function broadcast() {
  const aUrl = `http://127.0.0.1:${process.argv[3] ?? '8080'}`;
  const bUrl = `http://127.0.0.1:${process.argv[4] ?? '8081'}`;
  const a = await connect(aUrl, 'bc-a');
  const b = await connect(bUrl, 'bc-b');
  console.log(`[broadcast] 客户端 A 连 ${aUrl}，客户端 B 连 ${bUrl}`);

  const payload = op('upsert', 'el-bc', 1, 1, 'op-bc-1');
  const applyA = once(a, 'op:apply', (p) => p.op?.opId === 'op-bc-1');
  const applyB = once(b, 'op:apply', (p) => p.op?.opId === 'op-bc-1', 15_000);

  a.emit('op:submit', { boardId: BOARD_ID, clientId: 'bc-a', ops: [payload] });
  const ack = await once(a, 'op:ack', (p) => p.opId === 'op-bc-1');
  const [msgA, msgB] = await Promise.all([applyA, applyB]);

  console.log('[broadcast] ack =', JSON.stringify(ack));
  console.log('[broadcast] A(8080) 收到 op:apply =', JSON.stringify(msgA));
  console.log('[broadcast] B(8081) 收到 op:apply =', JSON.stringify(msgB));
  a.close();
  b.close();
}

const mode = process.argv[2];
const modes = { reset, dump, idem, lww, seq, broadcast };

if (!modes[mode]) {
  console.error(`未知模式：${mode}，可用：${Object.keys(modes).join(' / ')}`);
  process.exit(1);
}

await db.connect();
try {
  await modes[mode]();
} finally {
  await db.end();
}
