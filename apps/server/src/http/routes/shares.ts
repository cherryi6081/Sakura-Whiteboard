import express, { Router } from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { pool } from '../../infra/db.js';
import { AppError } from '../middlewares/error.js';
import { boardIdSchema } from '../../domain/opPage.js';
import { identityOf } from '../../auth/identity.js';
import { resolveBoardAccess } from '../../domain/access.js';
import { buildPdfFromPng, clampPdfScale, isPngSignature, readPngPixelSizeOf, PDF_EXPORT_MAX_PIXELS } from '../../domain/pdfExport.js';
import { shareTokenOf } from './assets.js';
import {
  clientIp,
  pdfExportIdentityRule,
  pdfExportIpRule,
  rateLimitConsumeAll,
} from '../middlewares/rateLimit.js';
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
export async function requireOwner(
  req: Request,
  boardId: string,
  action = '管理分享链接',
): Promise<AccessibleBoard> {
  const identity = identityOf(req);
  const access = await resolveBoardAccess(boardId, identity);
  if (!access.ok) throw new AppError(404, 'NOT_FOUND', 'board not found');
  if (access.role !== 'owner') {
    throw new AppError(403, 'FORBIDDEN', `只有白板所有者可以${action}`);
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
      /**
       * 用 fragment 承载 token：fragment 不会随请求发给服务端（不进 access log / Referer），
       * 也不改现有 `/board/:id` 路由。REST/WS 仍走 `x-share-token` 头与 join payload。
       */
      url: `/board/${boardId}#share=${token}`,
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

const patchShareSchema = z.object({
  permission: z.enum(['read', 'edit']),
});

/**
 * 改权限：只允许 read/edit 互换，复用 owner 校验。
 * 已吊销的链接不允许再改（返回 404，与"链接不存在"同口径）。
 * 更新后必须清 `share:` 缓存，否则旧权限会一直生效到缓存过期。
 */
sharesRouter.patch(
  '/boards/:id/share-links/:linkId',
  handle(async (req, res) => {
    const boardId = boardIdSchema.parse(req.params.id);
    const linkId = z.string().uuid().parse(req.params.linkId);
    const { permission } = patchShareSchema.parse(req.body ?? {});
    await requireOwner(req, boardId);

    const { rows } = await pool.query<{ token_hash: string; permission: SharePermission }>(
      `update share_links
          set permission = $3
        where id = $1 and board_id = $2 and revoked_at is null
        returning token_hash, permission`,
      [linkId, boardId, permission],
    );
    const row = rows[0];
    if (!row) throw new AppError(404, 'NOT_FOUND', 'share link not found');

    await invalidateShareCache(row.token_hash);
    res.json({ id: linkId, boardId, permission: row.permission });
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

/* ------------------------------------------------------------------------------------
 * PDF 导出（服务端）
 *
 * 客户端已经产出整张画布 + 16px 留白的 PNG（描边/字体/图片都按浏览器渲染结果），
 * 这里只做 PNG → 单页 PDF 的封装，因此不需要 Chromium 之类的浏览器二进制。
 *
 * 权限：**能读这块板就能导出**。直接复用 `resolveBoardAccess`（含分享 token 头路径），
 * 所有者 / 编辑者 / 只读成员 / 持 read token 的匿名访客 / 公共临时板全部放行；
 * 无权访问者仍按 404 拒绝，不暴露板是否存在。
 *
 * 防滥用：按「用户（游客按浏览器身份）+ IP」双闸门限流，阈值对齐实时通道 join
 * （5 次/分钟/身份、20 次/分钟/IP）；超限回 429 + Retry-After，不静默失败。
 *
 * 体积：仅本路由放宽到 32MB（大画布 2x 渲染的 PNG 会顶到统一 5MB 线），
 * 图片资产 / 头像 / 缩略图仍走 `LIMITS.assetMaxBytes`，没有全局改口径。
 * ------------------------------------------------------------------------------------ */

const PDF_EXPORT_MAX_BYTES = 32 * 1024 * 1024;
const PDF_EXPORT_MAX_MB = PDF_EXPORT_MAX_BYTES / (1024 * 1024);

/**
 * `express.raw` 的超限错误发生在进入业务 handler 之前，会绕过 handle()，
 * 这里包一层把它翻译成本路由专属的 413 文案，避免和图片上传共用一句泛化提示。
 */
const rawPdfPng: RequestHandler = (req, res, next) => {
  express.raw({ type: () => true, limit: PDF_EXPORT_MAX_BYTES, inflate: false })(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    if ((err as { type?: string }).type === 'entity.too.large') {
      next(
        new AppError(
          413,
          'FILE_TOO_LARGE',
          `导出文件过大（上限 ${PDF_EXPORT_MAX_MB}MB），请降低导出倍率后重试`,
        ),
      );
      return;
    }
    next(err);
  });
};

const pdfExportQuerySchema = z.object({
  /** 客户端渲染 PNG 时的倍率；页面尺寸按它还原成逻辑尺寸 */
  scale: z.coerce.number().min(1).max(4).default(2),
});

sharesRouter.post(
  '/boards/:id/export/pdf',
  rawPdfPng,
  handle(async (req, res) => {
    const boardId = boardIdSchema.parse(req.params.id);
    const { scale } = pdfExportQuerySchema.parse(req.query);

    // 与图片上传同一套 CSRF 口径：自定义头强制跨站请求走预检
    if (req.get('x-wb-export') !== '1') {
      throw new AppError(403, 'FORBIDDEN', 'missing export intent header');
    }

    // 身份维度用 userId / guestId 收敛，未识别身份时退化为 IP 键；所有尝试都计数
    const identity = identityOf(req);
    const ip = clientIp(req);
    const identityKey = identity.userId
      ? `user:${identity.userId}`
      : identity.guestId
        ? `guest:${identity.guestId}`
        : `ip:${ip}`;
    const wait = await rateLimitConsumeAll([pdfExportIdentityRule(identityKey), pdfExportIpRule(ip)]);
    if (wait !== null) {
      res.setHeader('Retry-After', String(wait));
      throw new AppError(429, 'TOO_MANY_ATTEMPTS', `导出太频繁，请 ${wait} 秒后再试`);
    }

    // 读权限：分享 token 与登录/游客身份都走同一套解析
    const access = await resolveBoardAccess(boardId, identity, shareTokenOf(req));
    if (!access.ok) throw new AppError(404, 'NOT_FOUND', 'board not found');

    const bytes: unknown = req.body;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      throw new AppError(400, 'INVALID_INPUT', '请求体必须是非空 PNG 二进制');
    }
    if (!isPngSignature(bytes)) {
      throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'PDF 导出只接受 PNG');
    }

    // 像素闸门：只读 IHDR 宽高，在 pdf-lib 解码出整张 RGBA 之前拦截
    const pixels = readPngPixelSizeOf(bytes);
    if (!pixels) {
      throw new AppError(400, 'INVALID_INPUT', 'PNG 头非法或已截断，无法读取画布尺寸');
    }
    const totalPixels = pixels.width * pixels.height;
    if (totalPixels > PDF_EXPORT_MAX_PIXELS) {
      // 保留 3 位小数并去掉尾零，避免 24.005MP 被四舍五入成「24.00MP」显得没超限
      const actualMp = (totalPixels / 1_000_000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
      throw new AppError(
        413,
        'PIXEL_LIMIT_EXCEEDED',
        `导出画布像素超限：当前 ${actualMp}MP，上限 ${PDF_EXPORT_MAX_PIXELS / 1_000_000}MP；请降低导出倍率（建议改用 1 倍导出）`,
      );
    }

    let pdf: Uint8Array;
    try {
      pdf = await buildPdfFromPng(bytes, clampPdfScale(scale));
    } catch {
      throw new AppError(400, 'INVALID_INPUT', 'PNG 解析失败，无法生成 PDF');
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', String(pdf.byteLength));
    // 每次导出都是即时产物，不缓存
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // 零拷贝包装：pdf-lib 的 save() 已是 Uint8Array，避免为 32MB 级产物再复制一份 Buffer
    res.status(200).send(Buffer.from(pdf.buffer, pdf.byteOffset, pdf.byteLength));
  }),
);
