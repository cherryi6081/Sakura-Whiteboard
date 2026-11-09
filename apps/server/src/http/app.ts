import '../load-env.js';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import express from 'express';
import { config } from '../config.js';
import { healthRouter } from './routes/health.js';
import { boardsRouter } from './routes/boards.js';
import { authRouter } from './routes/auth.js';
import { guestRouter } from './routes/guest.js';
import { sharesRouter } from './routes/shares.js';
import { assetsRouter } from './routes/assets.js';
import { attachIdentity } from '../auth/identity.js';
import { errorHandler, notFound } from './middlewares/error.js';

/**
 * 生产镜像里前端由 API 同源托管（`WEB_DIST` 指向构建产物）。
 * 好处：cookie 同源、无需 Vite 代理、`--scale api=2` 每个实例都能直接出页面。
 * 开发环境不设该变量，交回 Vite dev server。
 */
function mountWeb(app: express.Express) {
  if (!config.WEB_DIST) return;
  const dist = resolve(process.cwd(), config.WEB_DIST);
  const indexHtml = join(dist, 'index.html');
  if (!existsSync(indexHtml)) {
    console.warn('[web] WEB_DIST 指向的目录没有 index.html，仅提供 API', { dist });
    return;
  }
  app.use(express.static(dist, { index: false }));
  app.get('*', (req, res, next) => {
    // /api 与 /socket.io（含其 404）继续走 JSON 错误契约，不能被 SPA fallback 吞掉
    if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexHtml, (err) => {
      if (err) next(err);
    });
  });
}

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  // 身份只从签名 cookie / Redis 会话推导（M5-1）；所有 /api 路由共享同一个 req.identity
  app.use('/api', attachIdentity);

  app.use('/api', healthRouter);
  app.use('/api', authRouter);
  app.use('/api', guestRouter);
  app.use('/api', sharesRouter);
  app.use('/api', assetsRouter);
  app.use('/api', boardsRouter);

  mountWeb(app);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
