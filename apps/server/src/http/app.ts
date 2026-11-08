import '../load-env.js';
import express from 'express';
import { healthRouter } from './routes/health.js';
import { boardsRouter } from './routes/boards.js';
import { authRouter } from './routes/auth.js';
import { guestRouter } from './routes/guest.js';
import { attachIdentity } from '../auth/identity.js';
import { errorHandler, notFound } from './middlewares/error.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  // 身份只从签名 cookie / Redis 会话推导（M5-1）；所有 /api 路由共享同一个 req.identity
  app.use('/api', attachIdentity);

  app.use('/api', healthRouter);
  app.use('/api', authRouter);
  app.use('/api', guestRouter);
  app.use('/api', boardsRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
