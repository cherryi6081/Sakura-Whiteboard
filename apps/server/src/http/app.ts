import '../load-env.js';
import express from 'express';
import { healthRouter } from './routes/health.js';
import { boardsRouter } from './routes/boards.js';
import { errorHandler, notFound } from './middlewares/error.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  app.use('/api', healthRouter);
  app.use('/api', boardsRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
