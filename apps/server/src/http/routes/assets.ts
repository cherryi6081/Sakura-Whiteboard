import { Router } from 'express';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ASSET_MIME_TYPES, LIMITS } from '@whiteboard/shared';
import { pool } from '../../infra/db.js';
import { storage, StorageError } from '../../infra/storage.js';
import { AppError } from '../middlewares/error.js';
import { identityOf } from '../../auth/identity.js';
import { boardIdSchema } from '../../domain/opPage.js';
import { resolveBoardAccess } from '../../domain/access.js';
import { detectImage } from '../../domain/imageFile.js';
import { assetRawPath, verifyAssetAccess } from '../../domain/assetUrl.js';

/**
 * 图片资产 REST（v1.1，开发文档 §4.6 第二章）。
 *
 * - 上传：`POST /api/boards/:id/assets`，body 是**图片二进制原始字节**（不是 multipart）。
 *   契约变化已写进文档：服务端只需要字节 + `Content-Type`，原始 body 比 multipart 更少依赖、
 *   也更容易做"限制 5MB"与魔数校验；前端用 `fetch(blob)` 即可。
 * - 权限：仅**登录用户**且对该板有编辑权（owner/editor）可上传；游客一律 401（Q5）。
 * - 读取：`GET /api/assets/:id/url` 走身份/分享 token 判权后返回短时签名 URL；
 *   `GET /api/assets/:id/raw` 只认签名，供 `<img src>` 使用。
 */

export const assetsRouter = Router();

const handle =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

/** 只解析原始字节；`inflate: false` 拒绝压缩体，避免解压炸弹。 */
const rawImage = express.raw({ type: () => true, limit: LIMITS.assetMaxBytes, inflate: false });

/** 分享 token 只用于"匿名凭链接进入"，不是身份；上传仍要求登录。 */
function shareTokenOf(req: Request): string | null {
  const fromQuery = typeof req.query.share === 'string' ? req.query.share : null;
  const fromHeader = typeof req.headers['x-share-token'] === 'string' ? req.headers['x-share-token'] : null;
  return fromQuery ?? fromHeader;
}

type AssetRow = {
  id: string;
  board_id: string;
  mime: string;
  size_bytes: number;
  width: number;
  height: number;
  sha256: string;
  created_at: Date;
};

const ASSET_COLUMNS = 'id, board_id, mime, size_bytes, width, height, sha256, created_at';

const toAsset = (row: AssetRow) => ({
  id: row.id,
  boardId: row.board_id,
  mime: row.mime,
  size: row.size_bytes,
  width: row.width,
  height: row.height,
  sha256: row.sha256,
  createdAt: row.created_at.toISOString(),
});

async function loadAsset(assetId: string): Promise<(AssetRow & { status: string; storage_key: string }) | null> {
  const { rows } = await pool.query<AssetRow & { status: string; storage_key: string }>(
    `select ${ASSET_COLUMNS}, status, storage_key from assets where id = $1`,
    [assetId],
  );
  return rows[0] ?? null;
}

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const assetIdSchema = z.string().uuid();

/**
 * 上传图片。错误口径：
 * - 401 未登录（游客不可上传，Q5）
 * - 403 登录但只读
 * - 404 板不存在/无权访问（不暴露私有板存在性）
 * - 413 `FILE_TOO_LARGE` / `BOARD_QUOTA_EXCEEDED`
 * - 415 `UNSUPPORTED_MEDIA_TYPE`（非白名单、魔数不符、声明与实际不一致）
 * - 503 `STORAGE_UNAVAILABLE`（磁盘/对象存储故障）
 */
assetsRouter.post(
  '/boards/:id/assets',
  rawImage,
  handle(async (req, res) => {
    const boardId = boardIdSchema.parse(req.params.id);
    const identity = identityOf(req);

    if (!identity.userId) {
      throw new AppError(401, 'UNAUTHENTICATED', '图片上传需要登录；游客与只读访客不可上传');
    }

    const access = await resolveBoardAccess(boardId, identity, shareTokenOf(req));
    if (!access.ok) throw new AppError(404, 'NOT_FOUND', 'board not found');
    if (access.role === 'viewer') {
      throw new AppError(403, 'FORBIDDEN', '只有对该白板有编辑权的用户可以上传图片');
    }

    const declared = String(req.headers['content-type'] ?? '')
      .split(';')[0]!
      .trim()
      .toLowerCase();
    if (!(ASSET_MIME_TYPES as readonly string[]).includes(declared)) {
      throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', `仅支持 ${ASSET_MIME_TYPES.join(' / ')}；不支持 SVG`);
    }

    const bytes: unknown = req.body;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      throw new AppError(400, 'INVALID_INPUT', '请求体必须是非空图片二进制');
    }
    if (bytes.length > LIMITS.assetMaxBytes) {
      throw new AppError(413, 'FILE_TOO_LARGE', `单张图片上限 ${LIMITS.assetMaxBytes / 1024 / 1024}MB`);
    }

    const detected = detectImage(bytes);
    if (!detected) {
      throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', '文件内容不是受支持的图片格式（服务端按魔数校验）');
    }
    if (detected.mime !== declared) {
      throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', `Content-Type 声明 ${declared}，实际内容是 ${detected.mime}`);
    }

    const sha256 = createHash('sha256').update(bytes).digest('hex');

    // 同板同内容秒传：直接复用已有资产（不重复写盘、不重复占配额）
    const { rows: duplicated } = await pool.query<AssetRow>(
      `select ${ASSET_COLUMNS} from assets where board_id = $1 and sha256 = $2 and status = 'active' limit 1`,
      [boardId, sha256],
    );
    if (duplicated[0]) {
      res.status(200).json({ asset: toAsset(duplicated[0]), deduped: true });
      return;
    }

    const { rows: usedRows } = await pool.query<{ used: string }>(
      `select coalesce(sum(size_bytes), 0)::text as used from assets where board_id = $1 and status = 'active'`,
      [boardId],
    );
    const used = Number(usedRows[0]?.used ?? 0);
    if (used + bytes.length > LIMITS.assetBoardQuotaBytes) {
      throw new AppError(
        413,
        'BOARD_QUOTA_EXCEEDED',
        `本板图片总量上限 ${LIMITS.assetBoardQuotaBytes / 1024 / 1024}MB，已用 ${(used / 1024 / 1024).toFixed(1)}MB`,
      );
    }

    const storageKey = `${boardId}/${sha256}`;
    try {
      await storage.put(storageKey, bytes);
    } catch (err) {
      const message = err instanceof StorageError ? '图片存储服务不可用，请稍后重试' : '图片存储写入失败';
      throw new AppError(503, 'STORAGE_UNAVAILABLE', message);
    }

    const inserted = await pool.query<AssetRow>(
      `insert into assets (board_id, uploader_id, uploader_guest_id, mime, size_bytes, width, height, storage_key, sha256)
       values ($1, $2, null, $3, $4, $5, $6, $7, $8)
       returning ${ASSET_COLUMNS}`,
      [boardId, identity.userId, detected.mime, bytes.length, detected.width, detected.height, storageKey, sha256],
    );
    const row = inserted.rows[0];
    if (!row) throw new AppError(500, 'INTERNAL', 'asset insert returned no row');

    res.status(201).json({ asset: toAsset(row), deduped: false });
  }),
);

/** 按板列出仍活跃的资产（GC 与排障共用同一口径）。 */
assetsRouter.get(
  '/boards/:id/assets',
  handle(async (req, res) => {
    const boardId = boardIdSchema.parse(req.params.id);
    const { limit } = listQuerySchema.parse(req.query);

    const access = await resolveBoardAccess(boardId, identityOf(req), shareTokenOf(req));
    if (!access.ok) throw new AppError(404, 'NOT_FOUND', 'board not found');
    if (access.role === 'viewer') throw new AppError(403, 'FORBIDDEN', '只有编辑者可以列出图片资产');

    const { rows } = await pool.query<AssetRow>(
      `select ${ASSET_COLUMNS} from assets
        where board_id = $1 and status = 'active'
        order by created_at desc, id
        limit $2`,
      [boardId, limit],
    );

    res.json({
      boardId,
      assets: rows.map(toAsset),
      totalBytes: rows.reduce((sum, row) => sum + row.size_bytes, 0),
    });
  }),
);

/** 签发短时签名 URL；这里是唯一的权限判定点（读取本身只认签名）。 */
assetsRouter.get(
  '/assets/:assetId/url',
  handle(async (req, res) => {
    const assetId = assetIdSchema.parse(req.params.assetId);
    const asset = await loadAsset(assetId);
    if (!asset || asset.status !== 'active') throw new AppError(404, 'NOT_FOUND', 'asset not found');

    const access = await resolveBoardAccess(asset.board_id, identityOf(req), shareTokenOf(req));
    if (!access.ok) throw new AppError(404, 'NOT_FOUND', 'asset not found');

    const { path, expiresAt } = assetRawPath(assetId);
    res.json({
      assetId,
      url: path,
      expiresAt: expiresAt.toISOString(),
      mime: asset.mime,
      size: asset.size_bytes,
      width: asset.width,
      height: asset.height,
    });
  }),
);

/** 读取原始字节：只认 `exp` + `sig`，不查身份（签名由上面的接口签发）。 */
assetsRouter.get(
  '/assets/:assetId/raw',
  handle(async (req, res) => {
    const assetId = assetIdSchema.safeParse(req.params.assetId);
    if (!assetId.success) throw new AppError(404, 'NOT_FOUND', 'asset not found');

    const exp = typeof req.query.exp === 'string' ? req.query.exp : null;
    const sig = typeof req.query.sig === 'string' ? req.query.sig : null;
    if (!verifyAssetAccess(assetId.data, exp, sig)) {
      throw new AppError(403, 'FORBIDDEN', 'asset signature invalid or expired');
    }

    const asset = await loadAsset(assetId.data);
    if (!asset || asset.status !== 'active') throw new AppError(404, 'NOT_FOUND', 'asset not found');

    let bytes: Buffer | null;
    try {
      bytes = await storage.read(asset.storage_key);
    } catch {
      throw new AppError(503, 'STORAGE_UNAVAILABLE', '图片存储服务不可用，请稍后重试');
    }
    if (!bytes) throw new AppError(404, 'NOT_FOUND', 'asset bytes missing');

    res.setHeader('Content-Type', asset.mime);
    res.setHeader('Content-Length', String(bytes.length));
    // 签名 URL 本身带时效；允许浏览器缓存到过期前，但用 private 避免共享缓存
    res.setHeader('Cache-Control', 'private, max-age=600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.send(bytes);
  }),
);
