import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { logger } from '../../infra/logger.js';

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function notFound(req: Request, res: Response): void {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `no route for ${req.method} ${req.path}` } });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'invalid input', issues: err.issues } });
    return;
  }

  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }

  // express.json() 等中间件抛出的客户端错误会自带 4xx status（如非法 JSON = 400）
  const bodyError = err as { status?: number; code?: string; type?: string };
  if (typeof bodyError.status === 'number' && bodyError.status >= 400 && bodyError.status < 500) {
    // body-parser 的体积上限：图片上传必须给出可区分的错误码，不能被兜成 BAD_REQUEST
    if (bodyError.type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'FILE_TOO_LARGE', message: '上传内容超过大小上限' } });
      return;
    }
    const code = bodyError.type === 'entity.parse.failed' ? 'MALFORMED_JSON' : 'BAD_REQUEST';
    res.status(bodyError.status).json({ error: { code, message: code === 'MALFORMED_JSON' ? 'malformed json' : 'bad request' } });
    return;
  }

  logger.error({ err, path: req.path }, 'unhandled error');
  res.status(500).json({ error: { code: 'INTERNAL', message: 'internal error' } });
}
