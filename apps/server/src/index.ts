import './load-env.js';
import { createApp } from './http/app.js';
import { config } from './config.js';
import { logger } from './infra/logger.js';
import { closeDb, pingDb } from './infra/db.js';
import { closeRedis, pingRedis } from './infra/redis.js';

const app = createApp();

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT, env: config.NODE_ENV }, 'api listening');
});

void (async () => {
  const [db, redis] = await Promise.all([pingDb(), pingRedis()]);
  if (!db.ok) logger.warn({ error: db.error }, 'postgres not reachable at boot');
  if (!redis.ok) logger.warn({ error: redis.error }, 'redis not reachable at boot');
})();

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  server.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
