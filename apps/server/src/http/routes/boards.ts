import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { pool } from '../../infra/db.js';
import { getBoardForJoin, type BoardRow } from '../../realtime/opStore.js';
import { AppError } from '../middlewares/error.js';
import { boardIdSchema, needsResync, opsQuerySchema, paginatePage } from '../../domain/opPage.js';

/**
 * M2-C5 补拉与整板快照的 REST 接口。
 *
 * **鉴权缺口（如实标注，与 §7.2.1 同源）**：当前仍没有会话 / `wb_gid` cookie / 分享 token。
 * 这里的最小规则是「板存在、未归档、`share_mode != private`」即可读：
 * - `private` 板一律 404（不暴露存在性），连 owner 自己都读不到；
 * - `link_read` / `link_edit` 板只要知道 12 位 boardId 就能读（无 token 校验）。
 * 这只能支撑"补拉链路联调"，**不是可交付的权限实现**；M5 接入签名 token 后必须替换。
 * 写接口（`POST /ops`）本阶段不开放，写仍然只走 WebSocket 的 `op:submit`。
 */
export const boardsRouter = Router();

async function loadReadableBoard(boardId: string): Promise<BoardRow> {
  const board = await getBoardForJoin(boardId);
  if (!board || board.archived_at || board.share_mode === 'private') {
    throw new AppError(404, 'NOT_FOUND', 'board not found');
  }
  return board;
}

const handle =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

type OpRow = {
  seq: string;
  op_id: string;
  client_id: string;
  kind: string;
  element_id: string;
  payload: Record<string, unknown>;
};

/** `GET /api/boards/:id/ops?since=<seq>&limit=` —— 按 seq 升序补拉。 */
boardsRouter.get(
  '/boards/:id/ops',
  handle(async (req, res) => {
    const boardId = boardIdSchema.parse(req.params.id);
    const { since, limit } = opsQuerySchema.parse(req.query);
    const board = await loadReadableBoard(boardId);

    if (needsResync(since, board.last_seq)) {
      res.json({
        boardId,
        since,
        lastSeq: board.last_seq,
        resync: true,
        hasMore: false,
        nextSince: board.last_seq,
        ops: [],
      });
      return;
    }

    const { rows } = await pool.query<OpRow>(
      `select seq, op_id, client_id, kind, element_id, payload
         from board_ops
        where board_id = $1 and seq > $2
        order by seq asc
        limit $3`,
      [boardId, since, limit + 1],
    );

    const pageRows = rows.slice(0, limit);
    const lastPageRow = pageRows[pageRows.length - 1];
    const lastRowSeq = lastPageRow ? Number(lastPageRow.seq) : null;
    const page = paginatePage({ since, limit, rowCount: rows.length, lastRowSeq });

    res.json({
      boardId,
      since,
      lastSeq: board.last_seq,
      resync: false,
      hasMore: page.hasMore,
      nextSince: page.nextSince,
      ops: pageRows.map((row) => ({
        seq: Number(row.seq),
        opId: row.op_id,
        clientId: row.client_id,
        kind: row.kind,
        elementId: row.element_id,
        op: row.payload,
      })),
    });
  }),
);

type ElementRow = {
  element_id: string;
  version: string;
  version_nonce: string;
  data: Record<string, unknown>;
};

/** `GET /api/boards/:id/snapshot` —— 整板重载（gap 过大或补拉失败时回退）。 */
boardsRouter.get(
  '/boards/:id/snapshot',
  handle(async (req, res) => {
    const boardId = boardIdSchema.parse(req.params.id);
    const board = await loadReadableBoard(boardId);

    const { rows } = await pool.query<ElementRow>(
      `select element_id, version, version_nonce, data
         from elements
        where board_id = $1 and is_deleted = false
        order by zindex_key asc, element_id asc`,
      [boardId],
    );

    res.json({
      boardId,
      seq: board.last_seq,
      elements: rows.map((row) => ({
        ...row.data,
        id: row.element_id,
        version: Number(row.version),
        versionNonce: Number(row.version_nonce),
        isDeleted: false,
      })),
    });
  }),
);
