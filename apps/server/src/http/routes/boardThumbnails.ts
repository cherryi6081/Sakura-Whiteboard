import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { createHash } from 'node:crypto';
import { pool } from '../../infra/db.js';
import { storage, StorageError } from '../../infra/storage.js';
import { AppError } from '../middlewares/error.js';
import { identityOf } from '../../auth/identity.js';
import { boardIdSchema } from '../../domain/opPage.js';
import { resolveBoardAccess } from '../../domain/access.js';
import { detectImage } from '../../domain/imageFile.js';
import { shareTokenOf } from './assets.js';

/**
 * 白板缩略图（服务端远端副本）。
 *
 * - 客户端在离开白板时把本地已拍好的首帧 WebP 上传一次，服务端只做"覆盖式"保存：
 *   每板固定一个 key，`boards.thumbnail_url` 里带内容哈希做缓存失效。
 * - 图片本体是纯展示派生物，不写 `assets` 表、不占白板图片配额，也不参与资产 GC。
 * - 只有登录用户且有编辑权才能上传；读取沿用 `resolveBoardAccess`（含分享 token）。
 */
export const boardThumbnailsRouter = Router();

const handle =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

/** 640×400 WebP 常见 8–30KB，512KB 足够覆盖 PNG 回退 */
const THUMB_MAX_BYTES = 512 * 1024;
const THUMB_MIME_TYPES = new Set(['image/webp', 'image/png', 'image/jpeg']);
const rawImage = express.raw({ type: () => true, limit: THUMB_MAX_BYTES, inflate: false });

/** 每板固定 key：新的缩略图直接覆盖旧的，不会在磁盘上堆积历史版本 */
const storageKeyOf = (boardId: string) => `${boardId}/thumbnail`;

boardThumbnailsRouter.put(
  '/boards/:id/thumbnail',
  rawImage,
  handle(async (req, res) => {
    const boardId = boardIdSchema.parse(req.params.id);
    const identity = identityOf(req);

    // 与图片上传同一套 CSRF 口径：自定义头强制跨站请求走预检
    if (req.get('x-wb-upload') !== '1') {
      throw new AppError(403, 'FORBIDDEN', 'missing upload intent header');
    }
    if (!identity.userId) {
      throw new AppError(401, 'UNAUTHENTICATED', '缩略图上传需要登录');
    }

    const access = await resolveBoardAccess(boardId, identity, shareTokenOf(req));
    if (!access.ok) throw new AppError(404, 'NOT_FOUND', 'board not found');
    if (access.role === 'viewer') {
      throw new AppError(403, 'FORBIDDEN', '只有对该白板有编辑权的用户可以上传缩略图');
    }

    const bytes: unknown = req.body;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      throw new AppError(400, 'INVALID_INPUT', '请求体必须是非空图片二进制');
    }
    if (bytes.length > THUMB_MAX_BYTES) {
      throw new AppError(413, 'FILE_TOO_LARGE', `缩略图上限 ${THUMB_MAX_BYTES / 1024}KB`);
    }
    const detected = detectImage(bytes);
    if (!detected || !THUMB_MIME_TYPES.has(detected.mime)) {
      throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', '缩略图仅支持 WebP / PNG / JPEG');
    }

    try {
      await storage.put(storageKeyOf(boardId), bytes);
    } catch (err) {
      const message = err instanceof StorageError ? '图片存储服务不可用，请稍后重试' : '缩略图写入失败';
      throw new AppError(503, 'STORAGE_UNAVAILABLE', message);
    }

    // 版本号放 query 里，列表页的 <img> 能直接复用旧 URL 的缓存策略
    const version = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
    const thumbnailUrl = `/api/boards/${boardId}/thumbnail?v=${version}`;
    await pool.query('update boards set thumbnail_url = $2 where id = $1', [boardId, thumbnailUrl]);

    res.status(200).json({ boardId, thumbnailUrl });
  }),
);

boardThumbnailsRouter.get(
  '/boards/:id/thumbnail',
  handle(async (req, res) => {
    const boardId = boardIdSchema.parse(req.params.id);
    const access = await resolveBoardAccess(boardId, identityOf(req), shareTokenOf(req));
    if (!access.ok) throw new AppError(404, 'NOT_FOUND', 'board not found');

    let bytes: Buffer | null;
    try {
      bytes = await storage.read(storageKeyOf(boardId));
    } catch {
      throw new AppError(503, 'STORAGE_UNAVAILABLE', '图片存储服务不可用，请稍后重试');
    }
    if (!bytes) throw new AppError(404, 'NOT_FOUND', 'thumbnail not found');

    const detected = detectImage(bytes);
    res.setHeader('Content-Type', detected?.mime ?? 'image/webp');
    res.setHeader('Content-Length', String(bytes.length));
    // URL 里的 v 随内容变化，浏览器可以放心长缓存；私有缓存避免中间代理串身份
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.send(bytes);
  }),
);
