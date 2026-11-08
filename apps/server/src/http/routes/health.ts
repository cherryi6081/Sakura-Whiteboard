import { Router } from 'express';
import { pingDb } from '../../infra/db.js';
import { pingRedis } from '../../infra/redis.js';
import { config } from '../../config.js';

export const healthRouter = Router();

healthRouter.get('/health', async (_req, res) => {
  const [db, redis] = await Promise.all([pingDb(), pingRedis()]);
  const ok = db.ok && redis.ok;

  res.status(ok ? 200 : 503).json({
    ok,
    service: 'whiteboard-api',
    instance: config.INSTANCE_ID,
    uptimeSec: Number(process.uptime().toFixed(1)),
    dependencies: { db, redis },
  });
});
