import { Router } from 'express';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { ASSET_MIME_TYPES, LIMITS, type AssetMime } from '@whiteboard/shared';
import { pool } from '../../infra/db.js';
import { storage, StorageError } from '../../infra/storage.js';
import { detectImage } from '../../domain/imageFile.js';
import { identityOf, requireUser } from '../../auth/identity.js';
import { AppError } from '../middlewares/error.js';
import { sameOriginOnly, toUser, type UserRow } from './auth.js';

/**
 * 头像上传与读取。
 *
 * - `POST /api/account/avatar`：body 是图片**原始字节**（与白板图片同一套契约，不走 multipart），
 *   需登录 + 自定义头 `x-wb-upload: 1`（跨站预检过不去）。落盘 key 为
 *   `avatars/<随机 uuid>.<ext>`，随后把 `/api/avatars/<file>` 写回 `users.avatar_url`。
 * - `GET /api/avatars/:file`：公开读取（同源页面才能引用），文件名随机且不可枚举；
 *   只接受服务端生成的文件名形状，任何其它路径直接 404，不存在路径穿越。
 *
 * 安全口径：
 * - 类型白名单与白板图片一致（PNG/JPEG/WebP/GIF），**不收 SVG**；
 * - 大小上限 `LIMITS.avatarMaxBytes`（2MB），由 body parser 直接拒绝超限；
 * - 不信任扩展名与 `Content-Type`，按魔数识别并与声明比对，不一致 415；
 * - 文件名完全由服务端 `randomUUID()` 生成，不含用户输入。
 */

export const avatarRouter = Router();

const handle =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

/** 只解析原始字节；`inflate: false` 拒绝压缩体，避免解压炸弹。 */
const rawImage = express.raw({ type: () => true, limit: LIMITS.avatarMaxBytes, inflate: false });

const AVATAR_URL_PREFIX = '/api/avatars/';
const AVATAR_FILE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp|gif)$/;

const EXT_BY_MIME: Record<AssetMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const MIME_BY_EXT: Record<string, AssetMime> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

/** 只清理本服务生成的头像文件；GitHub 等外链一律不动。 */
async function removeReplacedUpload(previous: string | null, current: string): Promise<void> {
  if (!previous || previous === current || !previous.startsWith(AVATAR_URL_PREFIX)) return;
  const file = previous.slice(AVATAR_URL_PREFIX.length);
  if (!AVATAR_FILE_PATTERN.test(file)) return;
  try {
    await storage.delete(`avatars/${file}`);
  } catch {
    // 旧文件清理失败不影响本次上传结果（最多留一个孤儿文件）
  }
}

avatarRouter.post(
  '/account/avatar',
  sameOriginOnly,
  requireUser,
  rawImage,
  handle(async (req, res) => {
    // CSRF：自定义头会强制跨站请求先发预检，而本服务不返回 CORS 头 → 跨站写失败
    if (req.get('x-wb-upload') !== '1') {
      throw new AppError(403, 'FORBIDDEN', 'missing upload intent header');
    }

    const identity = identityOf(req);
    const userId = identity.userId;
    if (!userId) throw new AppError(401, 'UNAUTHENTICATED', '头像上传需要登录');

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
    if (bytes.length > LIMITS.avatarMaxBytes) {
      throw new AppError(413, 'FILE_TOO_LARGE', `头像上限 ${LIMITS.avatarMaxBytes / 1024 / 1024}MB`);
    }

    const detected = detectImage(bytes);
    if (!detected) {
      throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', '文件内容不是受支持的图片格式（服务端按魔数校验）');
    }
    if (detected.mime !== declared) {
      throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', `Content-Type 声明 ${declared}，实际内容是 ${detected.mime}`);
    }

    const file = `${randomUUID()}.${EXT_BY_MIME[detected.mime]}`;
    const avatarUrl = `${AVATAR_URL_PREFIX}${file}`;
    try {
      await storage.put(`avatars/${file}`, bytes);
    } catch (err) {
      const message = err instanceof StorageError ? '头像存储服务不可用，请稍后重试' : '头像存储写入失败';
      throw new AppError(503, 'STORAGE_UNAVAILABLE', message);
    }

    const previous = await pool.query<{ avatar_url: string | null }>('select avatar_url from users where id = $1', [userId]);
    const { rows } = await pool.query<UserRow>(
      `update users set avatar_url = $2
        where id = $1 and status = 'active'
        returning id, email, display_name, color, avatar_url`,
      [userId, avatarUrl],
    );
    const row = rows[0];
    if (!row) throw new AppError(401, 'UNAUTHENTICATED', 'session user missing');

    await removeReplacedUpload(previous.rows[0]?.avatar_url ?? null, avatarUrl);
    res.json({ user: toUser(row) });
  }),
);

avatarRouter.get(
  '/avatars/:file',
  handle(async (req, res) => {
    const file = req.params.file;
    if (!file || !AVATAR_FILE_PATTERN.test(file)) throw new AppError(404, 'NOT_FOUND', 'avatar not found');
    const mime = MIME_BY_EXT[file.split('.').pop() ?? ''];
    if (!mime) throw new AppError(404, 'NOT_FOUND', 'avatar not found');

    let bytes: Buffer | null;
    try {
      bytes = await storage.read(`avatars/${file}`);
    } catch {
      throw new AppError(503, 'STORAGE_UNAVAILABLE', '头像存储服务不可用，请稍后重试');
    }
    if (!bytes) throw new AppError(404, 'NOT_FOUND', 'avatar not found');

    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', String(bytes.length));
    // 文件名随机且每次上传都换新，内容不会变，可以长期缓存
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.send(bytes);
  }),
);
