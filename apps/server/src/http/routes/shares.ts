import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { pool } from '../../infra/db.js';
import { AppError } from '../middlewares/error.js';
import { boardIdSchema } from '../../domain/opPage.js';
import { identityOf } from '../../auth/identity.js';
import { resolveBoardAccess } from '../../domain/access.js';
import {
  generateShareToken,
  hashShareToken,
  invalidateShareCache,
  writeShareCache,
  type SharePermission,
} from '../../domain/shareLinks.js';

/**
 * 分享链接 REST（M5-2，开发文档 §7.1.4）。
 *
 * - 创建/列出/吊销都要求 **owner**（登录用户或游客本人）；token 不给管理权。
 * - 创建只在响应里返回一次明文 token，库里存 `sha256`。
 * - 吊销置 `revoked_at` 并**同步删除 `share:` 缓存**，保证下一次访问立即失效。
 * - 未登录持 token 的读取/写入在 `resolveBoardAccess` 里统一判定（read→viewer，edit→editor）。
 */

export const sharesRouter = Router();

const handle =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

const DEFAULT_EXPIRES_DAYS = 7;
const MAX_EXPIRES_DAYS = 365;

const createShareSchema = z.object({
  permission: z.enum(['read', 'edit']),
  /** 缺省 7 天；显式 `null` = 永久（owner 主动选择） */
  expiresInDays: z.number().int().min(1).max(MAX_EXPIRES_DAYS).nullable().optional(),
});

type AccessibleBoard = { id: string };

/** 解析 owner 权限；不存在/无权一律按 404 处理（不暴露存在性）。 */
async function requireOwner(req: Request, boardId: string): Promise<AccessibleBoard> {
  const identity = identityOf(req);
  const access = await resolveBoardAccess(boardId, identity);
  if (!access.ok) throw new AppError(404, 'NOT_FOUND', 'board not found');
  if (access.role !== 'owner') {
    throw new AppError(403, 'FORBIDDEN', '只有白板所有者可以管理分享链接');
  }
  return { id: boardId };
}

sharesRouter.post(
  '/boards/:id/share-links',
  handle(async (req, res) => {
    const boardId = boardIdSchema.parse(req.params.id);
    const { permission, expiresInDays } = createShareSchema.parse(req.body ?? {});
    await requireOwner(req, boardId);

    const identity = identityOf(req);
    const token = generateShareToken();
    const tokenHash = hashShareToken(token);
    const days = expiresInDays === undefined ? DEFAULT_EXPIRES_DAYS : expiresInDays;
    const expiresAt = days === null ? null : new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    const { rows } = await pool.query<{ id: string; created_at: Date }>(
      `insert into share_links (board_id, token_hash, permission, created_by, created_by_guest_id, expires_at)
       values ($1, $2, $3, $4, $5, $6)
       returning id, created_at`,
      [
        boardId,
        tokenHash,
        permission,
        identity.userId,
        identity.userId ? null : identity.guestId,
        expiresAt,
      ],
    );
    const row = rows[0];
    if (!row) throw new AppError(500, 'INTERNAL', 'share link insert returned no row');

    await writeShareCache(tokenHash, {
      boardId,
      permission,
      expiresAt: expiresAt ? expiresAt.getTime() : null,
      revokedAt: null,
    });

    res.status(201).json({
      id: row.id,
      boardId,
      permission,
      /** 唯一一次返回明文 token；之后所有接口只给 id */
      token,
      url: `/board/${boardId}?share=${token}`,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
      createdAt: row.created_at.toISOString(),
    });
  }),
);

type ShareRow = {
  id: string;
  permission: SharePermission;
  expires_at: Date | null;
  revoked_at: Date | null;
  use_count: number;
  created_at: Date;
  created_by: string | null;
  created_by_guest_id: string | null;
};

sharesRouter.get(
  '/boards/:id/share-links',
  handle(async (req, res) => {
    const boardId = boardIdSchema.parse(req.params.id);
    await requireOwner(req, boardId);

    const { rows } = await pool.query<ShareRow>(
      `select id, permission, expires_at, revoked_at, use_count, created_at, created_by, created_by_guest_id
         from share_links
        where board_id = $1
        order by created_at desc
        limit 50`,
      [boardId],
    );

    res.json({
      boardId,
      links: rows.map((row) => ({
        id: row.id,
        permission: row.permission,
        expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
        revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
        useCount: row.use_count,
        createdAt: row.created_at.toISOString(),
        createdByType: row.created_by ? 'user' : 'guest',
        active: row.revoked_at === null && (row.expires_at === null || row.expires_at.getTime() > Date.now()),
      })),
    });
  }),
);

sharesRouter.delete(
  '/boards/:id/share-links/:linkId',
  handle(async (req, res) => {
    const boardId = boardIdSchema.parse(req.params.id);
    const linkId = z.string().uuid().parse(req.params.linkId);
    await requireOwner(req, boardId);

    const { rows } = await pool.query<{ token_hash: string }>(
      `update share_links
          set revoked_at = coalesce(revoked_at, now())
        where id = $1 and board_id = $2
        returning token_hash`,
      [linkId, boardId],
    );
    const row = rows[0];
    if (!row) throw new AppError(404, 'NOT_FOUND', 'share link not found');

    // 先删缓存再返回：下一次请求必然回落数据库，看到 revoked_at
    await invalidateShareCache(row.token_hash);
    res.status(204).end();
  }),
);
