import './load-env.js';
import { createApp } from './http/app.js';
import { config } from './config.js';
import { logger } from './infra/logger.js';
import { closeDb, pingDb } from './infra/db.js';
import { closeRedis, pingRedis } from './infra/redis.js';
import { attachRealtime } from './realtime/board.js';
import { startTrashGc } from './jobs/trashGc.js';

const app = createApp();

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT, env: config.NODE_ENV }, 'api listening');
});

const realtime = attachRealtime(server);
// 回收站每日 03:00（Asia/Shanghai）清理 30 天前的软删除白板
const stopTrashGc = startTrashGc();

void (async () => {
  const [db, redis] = await Promise.all([pingDb(), pingRedis()]);
  if (!db.ok) logger.warn({ error: db.error }, 'postgres not reachable at boot');
  if (!redis.ok) logger.warn({ error: redis.error }, 'redis not reachable at boot');
})();

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  stopTrashGc();
  await realtime.close().catch((err) => logger.warn({ err: String(err) }, 'realtime close failed'));
  server.close(() => undefined);
  await Promise.allSettled([closeDb(), closeRedis()]);
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
