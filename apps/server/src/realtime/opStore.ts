import type { ElementOp } from '@whiteboard/shared';
import { pool } from '../infra/db.js';
import { decideLww, type ExistingElementState } from '../domain/lww.js';
import { scheduleSnapshot } from '../domain/boardSnapshots.js';

/**
 * 一批 op 的落库事务（同一块板、已按提交顺序排好）：
 *
 * 1. 取板级 advisory lock，保证同一块板的元素裁决串行（避免两个实例同时插入同一 (board, element)）；
 * 2. 逐条 `select ... for update` 读当前元素（含墓碑）；
 * 3. 按 LWW 决定是否覆盖 `elements`；
 * 4. 无论是否被 LWW 覆盖，都追加一行 `board_ops`（审计/补拉需要）；
 * 5. 整批只写一次 `boards.last_seq = GREATEST(...)`，为 Redis `seq` 重建兜底。
 *
 * 批内顺序即提交顺序：同一个元素在一批里被改多次时，后一条会读到前一条未提交的结果，
 * 与逐条提交的 LWW 结论一致。事务失败会留下序号空洞；序号只保证严格单调，不保证连续。
 */

export type PersistOpInput = {
  boardId: string;
  clientId: string;
  userId: string | null;
  guestId: string | null;
  seq: number;
  op: ElementOp;
};

export type PersistOpResult = {
  applied: boolean;
  stale: boolean;
};

export async function persistOps(inputs: PersistOpInput[]): Promise<PersistOpResult[]> {
  const first = inputs[0];
  if (!first) return [];
  const boardId = first.boardId;
  const client = await pool.connect();

  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [boardId]);

    const results: PersistOpResult[] = [];

    for (const { clientId, userId, guestId, seq, op } of inputs) {
      const found = await client.query<{ version: number; version_nonce: number; is_deleted: boolean }>(
        `select version, version_nonce, is_deleted
           from elements
          where board_id = $1 and element_id = $2
            for update`,
        [boardId, op.id],
      );

      const row = found.rows[0];
      const existing: ExistingElementState | null = row
        ? { version: Number(row.version), versionNonce: Number(row.version_nonce), isDeleted: row.is_deleted }
        : null;

      const verdict = decideLww(existing, op);

      if (verdict.apply) {
        if (op.kind === 'upsert') {
          await client.query(
            `insert into elements (board_id, element_id, type, version, version_nonce, zindex_key, is_deleted, data, updated_at)
             values ($1, $2, $3, $4, $5, $6, false, $7::jsonb, now())
             on conflict (board_id, element_id) do update
               set type = excluded.type,
                   version = excluded.version,
                   version_nonce = excluded.version_nonce,
                   zindex_key = excluded.zindex_key,
                   is_deleted = false,
                   data = excluded.data,
                   updated_at = now()`,
            [boardId, op.id, op.type, op.version, op.versionNonce, op.zindexKey, JSON.stringify(op.data)],
          );
        } else {
          await client.query(
            `insert into elements (board_id, element_id, type, version, version_nonce, zindex_key, is_deleted, data, updated_at)
             values ($1, $2, $3, $4, $5, '', true, '{}'::jsonb, now())
             on conflict (board_id, element_id) do update
               set version = excluded.version,
                   version_nonce = excluded.version_nonce,
                   is_deleted = true,
                   updated_at = now()`,
            [boardId, op.id, op.type, op.version, op.versionNonce],
          );
        }
      }

      await client.query(
        `insert into board_ops (board_id, seq, op_id, client_id, user_id, guest_id, kind, element_id, payload)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
         on conflict (board_id, op_id) do nothing`,
        [boardId, seq, op.opId, clientId, userId, guestId, op.kind, op.id, JSON.stringify(op)],
      );

      results.push({ applied: verdict.apply, stale: verdict.stale });
    }

    // 一批只写一次水位；seq 在批内递增，取最大值即可
    const maxSeq = inputs.reduce((max, input) => Math.max(max, input.seq), 0);
    await client.query('update boards set last_seq = greatest(last_seq, $2) where id = $1', [boardId, maxSeq]);

    await client.query('commit');
    // 累计 op 数到阈值后异步落一份快照；放在 commit 之后，失败也不影响本批写入
    scheduleSnapshot(boardId, maxSeq);
    return results;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Redis `seq:` 缺失时用它重建分配器；稳态下每块板只在首次分配时查一次。 */
export async function getBoardLastSeq(boardId: string): Promise<number> {
  const { rows } = await pool.query<{ last_seq: string }>('select last_seq from boards where id = $1', [boardId]);
  return Number(rows[0]?.last_seq ?? 0);
}

export type BoardRow = {
  id: string;
  share_mode: 'private' | 'link_read' | 'link_edit';
  last_seq: number;
  archived_at: Date | null;
  deleted_at: Date | null;
  owner_id: string | null;
  owner_guest_id: string | null;
  /** 归属空间；游客板与公共临时板为 null */
  space_id: string | null;
  /** 公共临时板：所有匿名访客共用，授权不看 owner / 分享链接 */
  is_public: boolean;
};

export async function getBoardForJoin(boardId: string): Promise<BoardRow | null> {
  const { rows } = await pool.query<{
    id: string;
    share_mode: BoardRow['share_mode'];
    last_seq: string;
    archived_at: Date | null;
    deleted_at: Date | null;
    owner_id: string | null;
    owner_guest_id: string | null;
    space_id: string | null;
    is_public: boolean;
  }>(
    'select id, share_mode, last_seq, archived_at, deleted_at, owner_id, owner_guest_id, space_id, is_public from boards where id = $1',
    [boardId],
  );

  const row = rows[0];
  if (!row) return null;
  return { ...row, last_seq: Number(row.last_seq) };
}
