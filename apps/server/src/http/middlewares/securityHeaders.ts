import type { NextFunction, Request, Response } from 'express';
import { config } from '../../config.js';

/**
 * 统一安全响应头（开发文档 §7.1.1）。
 *
 * - 基础头（所有环境）：防 MIME 嗅探、禁 iframe 嵌套、不泄漏 Referer、关闭无关浏览器能力。
 * - HSTS / CSP 只在生产下发：
 *   开发环境前端由 Vite 提供（HMR 依赖 eval 与 ws），设 CSP 会直接打断调试；
 *   生产由本服务同源托管前端产物，策略才真正生效。
 *
 * CSP 与 Excalidraw 的兼容点：
 * - `style-src 'unsafe-inline'`：Excalidraw/React 大量使用 style 属性与运行时样式注入；
 * - `img-src ... data: blob:`：粘贴图片、缩略图与画布导出走 data/blob；
 * - `connect-src 'self' ws: wss:`：Socket.IO 协同与同源 REST；
 * - `worker-src 'self' blob:`：Excalidraw 的字体/图片处理 worker。
 * 图片签名 URL 与页面同源，无需额外放行；`/api/assets/:id/raw` 在路由内会覆盖成更严格的 CSP。
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  if (config.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Content-Security-Policy', CSP);
  }

  next();
}
