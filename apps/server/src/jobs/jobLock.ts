import { pool } from '../infra/db.js';
import { logger } from '../infra/logger.js';

/**
 * 跨实例任务互斥（多副本部署时同一任务只跑一份）。
 *
 * 用 PostgreSQL **会话级** advisory lock：
 * - `pg_try_advisory_lock` 不阻塞：抢不到直接返回 `locked:false`，调用方跳过本轮；
 * - 锁绑定在专用连接上，`finally` 里显式释放；
 * - 进程崩溃 / 容器被杀时连接断开，PostgreSQL 自动释放，不会留下永久死锁，
 *   因此不需要 Redis 租约那种 TTL 续期与过期误判；
 * - 同一任务在本进程内也可能被定时器与启动补跑同时触发，调用方再叠一层单飞即可。
 *
 * `hashtext` 有极小概率与其它 key 撞哈希；任务 key 统一带 `job-lock:` 前缀，
 * 撞车只会导致某轮跳过，不会破坏数据。
 */

export type JobLockOutcome<T> = { locked: true; result: T } | { locked: false };

export async function withJobLock<T>(name: string, run: () => Promise<T>): Promise<JobLockOutcome<T>> {
  const key = `job-lock:${name}`;
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ ok: boolean }>(
      'select pg_try_advisory_lock(hashtext($1)) as ok',
      [key],
    );
    if (!rows[0]?.ok) {
      logger.info({ job: name }, 'job lock busy, skip this run');
      return { locked: false };
    }
    try {
      return { locked: true, result: await run() };
    } finally {
      await client.query('select pg_advisory_unlock(hashtext($1))', [key]).catch((err: unknown) => {
        logger.warn(
          { job: name, err: err instanceof Error ? err.message : String(err) },
          'job lock release failed (connection close will release it)',
        );
      });
    }
  } finally {
    client.release();
  }
}
