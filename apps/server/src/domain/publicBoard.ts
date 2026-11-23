import { nanoid } from 'nanoid';
import type { ElementOp } from '@whiteboard/shared';
import { PUBLIC_BOARD_ID, PUBLIC_BOARD_TITLE } from '@whiteboard/shared';
import { pool } from '../infra/db.js';
import { getBoardLastSeq, persistOps } from '../realtime/opStore.js';
import { allocateSeqRange } from '../realtime/seq.js';
import { broadcastToBoard } from '../realtime/boardBroadcast.js';
import { takeSnapshot } from './boardSnapshots.js';

/**
 * 公共临时板（所有未登录访客共用一块）。
 *
 * - **固定 id**：`PUBLIC_BOARD_ID`，不按 `wb_gid` 各建各的；任意浏览器/设备打开
 *   都是同一行、同一个协作房间。
 * - **惰性创建**：第一个匿名请求触达时插入，之后只读；`is_public=true` 且
 *   `owner_id` / `owner_guest_id` 都为空（迁移 0013 放宽了归属互斥约束）。
 * - **不参与转入**：没有任何归属者，`/api/guest/claim` 永远不会把它搬给某个账号。
 * - **清空**：不删板、不删 op 审计；把当前所有未删除元素按正常 LWW 追加一批
 *   `delete` op，在线客户端通过 `op:apply` 自然收敛，离线客户端下次 join 补拉也会删掉。
 */

export type PublicBoardInfo = { id: string; title: string };

/** 取（必要时创建）公共临时板；重复调用幂等。 */
export async function ensurePublicBoard(): Promise<PublicBoardInfo> {
  await pool.query(
    `insert into boards (id, title, owner_id, owner_guest_id, share_mode, is_public)
     values ($1, $2, null, null, 'private', true)
     on conflict (id) do nothing`,
    [PUBLIC_BOARD_ID, PUBLIC_BOARD_TITLE],
  );
  const { rows } = await pool.query<{ id: string; title: string }>(
    'select id, title from boards where id = $1',
    [PUBLIC_BOARD_ID],
  );
  const row = rows[0];
  if (!row) throw new Error('public board missing after insert');
  return row;
}

type LiveElementRow = {
  element_id: string;
  type: string;
  version: string;
  version_nonce: string;
};

const RESET_CHUNK = 100;

/**
 * 清空公共板内容。
 *
 * 板级 advisory lock 串行化并发清空；元素按 LWW 追加 delete op（版本 +1），
 * 因此清空与普通编辑走同一条写路径（同一套 `board_ops` 审计、同一个 seq 空间）。
 * 返回实际清掉的元素数。
 */
export async function resetPublicBoard(): Promise<{ cleared: number }> {
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock(hashtext($1))', [`public-board-reset:${PUBLIC_BOARD_ID}`]);
    // 锁内再读，保证两次并发清空不会各自基于同一份旧状态重复追加
    const { rows } = await client.query<LiveElementRow>(
      `select element_id, type, version, version_nonce
         from elements
        where board_id = $1 and is_deleted = false
        order by element_id`,
      [PUBLIC_BOARD_ID],
    );
    if (rows.length === 0) {
      // 已经是空板也要把快照刷新到最新：旧快照可能还留着清空前的元素
      await takeSnapshot(PUBLIC_BOARD_ID).catch(() => null);
      return { cleared: 0 };
    }

    let cleared = 0;
    for (let start = 0; start < rows.length; start += RESET_CHUNK) {
      const chunk = rows.slice(start, start + RESET_CHUNK);
      const firstSeq = await allocateSeqRange(PUBLIC_BOARD_ID, chunk.length, () =>
        getBoardLastSeq(PUBLIC_BOARD_ID),
      );
      const ops: ElementOp[] = chunk.map((row) => ({
        kind: 'delete',
        opId: `reset_${nanoid(16)}`,
        id: row.element_id,
        type: row.type as ElementOp['type'],
        baseVersion: Number(row.version),
        version: Number(row.version) + 1,
        versionNonce: Math.floor(Math.random() * 1_000_000_000),
      }));

      const results = await persistOps(
        ops.map((op, index) => ({
          boardId: PUBLIC_BOARD_ID,
          clientId: 'public-board-reset',
          userId: null,
          // board_ops 要求写入者至少有一个身份；用一个保留的系统游客 id 留审计，
          // 不代表任何真实浏览器，也不会因此让某台设备获得归属
          guestId: 'system:public-reset',
          seq: firstSeq + index,
          op,
        })),
      );

      // 清空也走正常的下行广播：在线客户端按 op:apply 删除，不需要额外的 reset 协议
      for (const [index, op] of ops.entries()) {
        if (!results[index]?.applied) continue;
        cleared += 1;
        broadcastToBoard(PUBLIC_BOARD_ID, 'op:apply', {
          boardId: PUBLIC_BOARD_ID,
          seq: firstSeq + index,
          op,
          applied: true,
          stale: false,
          by: 'reset',
        });
      }
    }

    await client.query('update boards set last_edited_at = now() where id = $1', [PUBLIC_BOARD_ID]);
    // 清空后立刻落一份空快照：否则最新快照仍停在清空前（内容 + 旧 seq），
    // 新浏览器/新账号打开时会先画出旧元素再补拉 delete op（闪一下）。
    // 快照失败不影响清空本身（读路径会按元素表现算）。
    await takeSnapshot(PUBLIC_BOARD_ID).catch(() => null);
    return { cleared };
  } finally {
    await client
      .query('select pg_advisory_unlock(hashtext($1))', [`public-board-reset:${PUBLIC_BOARD_ID}`])
      .catch(() => undefined);
    client.release();
  }
}
