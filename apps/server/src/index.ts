import './load-env.js';
import { createApp } from './http/app.js';
import { config } from './config.js';
import { logger } from './infra/logger.js';
import { closeDb, pingDb } from './infra/db.js';
import { closeRedis, pingRedis } from './infra/redis.js';
import { attachRealtime } from './realtime/board.js';
import { startTrashGc } from './jobs/trashGc.js';
import { startGuestGc } from './jobs/guestGc.js';
import { startAssetGc } from './jobs/assetGc.js';
import { startLastEditedFlush } from './jobs/lastEditedFlush.js';

const app = createApp();

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT, env: config.NODE_ENV }, 'api listening');
});

const realtime = attachRealtime(server);
// 回收站每日 03:00（Asia/Shanghai）清理 30 天前的软删除白板
const stopTrashGc = startTrashGc();
// 游客板每日 03:10 两阶段清理；默认仅 production 开启（GUEST_GC_ENABLED）
const stopGuestGc = config.GUEST_GC_ENABLED ? startGuestGc() : null;
// 资产 GC 每日 03:20；默认仅 production 开启，默认 dry-run（ASSET_GC_APPLY 才真正回收）
const stopAssetGc = config.ASSET_GC_ENABLED ? startAssetGc() : null;
// `boards.last_edited_at` 每 5s 合并回写（Redis dirty:boards）
const stopLastEditedFlush = startLastEditedFlush();

void (async () => {
  const [db, redis] = await Promise.all([pingDb(), pingRedis()]);
  if (!db.ok) logger.warn({ error: db.error }, 'postgres not reachable at boot');
  if (!redis.ok) logger.warn({ error: redis.error }, 'redis not reachable at boot');
})();

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  stopTrashGc();
  stopGuestGc?.();
  stopAssetGc?.();
  stopLastEditedFlush();
  await realtime.close().catch((err) => logger.warn({ err: String(err) }, 'realtime close failed'));
  server.close(() => undefined);
  await Promise.allSettled([closeDb(), closeRedis()]);
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
