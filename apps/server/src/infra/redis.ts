import { Redis } from 'ioredis';
import { config, describeRedisTarget } from '../config.js';

let lastError: string | null = null;

export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
  // 不排队：库没起时命令立即失败，避免请求悬挂到超时
  enableOfflineQueue: false,
  connectTimeout: 3_000,
  // 本地未起 Redis 时最多退避重试 3 次就停，不刷屏、不拖住进程
  retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 1_000)),
});

redis.on('error', (err) => {
  const message = err.message.trim();
  const code = (err as NodeJS.ErrnoException).code;
  lastError = message || code || 'redis error';
});

export type PingResult = {
  ok: boolean;
  latencyMs?: number;
  target: string;
  error?: string;
};

export async function pingRedis(): Promise<PingResult> {
  const startedAt = performance.now();
  const target = describeRedisTarget();

  try {
    if (redis.status !== 'ready') await redis.connect();
    await redis.ping();
    lastError = null;
    return { ok: true, latencyMs: Number((performance.now() - startedAt).toFixed(2)), target };
  } catch (err) {
    const message = err instanceof Error ? err.message.trim() : String(err);
    const detail = lastError ?? (message || 'redis unavailable');
    const hint = detail.includes('ECONNREFUSED') ? '（Redis 未启动或端口不符：执行 npm run db:up 或检查 REDIS_URL）' : '';
    return { ok: false, target, error: `${detail}${hint}` };
  }
}

export async function closeRedis(): Promise<void> {
  redis.disconnect();
}
