import '../load-env.js';
import { pool } from '../infra/db.js';
import { logger } from '../infra/logger.js';
import { msUntilNextCleanup, TRASH_RETENTION_DAYS } from '../domain/retention.js';

/**
 * 回收站到期清理（设计稿 §06）：每天 03:00（Asia/Shanghai）永久删除
 * `deleted_at` 超过 30 天的白板。删除会级联 board_members / board_ops / elements / assets，
 * 对象文件由 `asset:gc` 另行回收。
 *
 * 清理幂等：多实例同时执行只会有一边删到行；未删到的实例返回 0。
 * 手动执行：`npm run trash:gc -w @whiteboard/server`。
 */
export async function purgeExpiredBoards(): Promise<number> {
  const { rowCount } = await pool.query(
    `delete from boards
      where deleted_at is not null
        and deleted_at <= now() - make_interval(days => $1::int)`,
    [TRASH_RETENTION_DAYS],
  );
  return rowCount ?? 0;
}

/**
 * 执行一次到期清理。进程内同一时刻只允许一轮（定时器与启动补跑不会重叠）；
 * 多副本之间不做互斥——两边同时 DELETE 时 PostgreSQL 行锁会让后到者删到 0 行，
 * 结果等价于只清理一次，不会重复删除或报错。
 */
let inFlight: Promise<number> | null = null;

export function runTrashGcOnce(): Promise<number> {
  if (inFlight) return inFlight;

  inFlight = purgeExpiredBoards()
    .then((purged) => {
      logger.info({ purged, retentionDays: TRASH_RETENTION_DAYS }, 'trash gc finished');
      return purged;
    })
    .catch((err: unknown) => {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'trash gc failed');
      throw err;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/** 在 API 进程内注册每日清理；返回停止函数，供优雅退出时清理定时器。 */
export function startTrashGc(): () => void {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const schedule = () => {
    if (stopped) return;
    const delay = msUntilNextCleanup();
    timer = setTimeout(() => {
      void runTrashGcOnce()
        .catch(() => undefined)
        .finally(schedule);
    }, delay);
    // 不因为一个定时器把进程钉住（测试/CLI 里尤其重要）
    timer.unref?.();
    logger.info({ inMs: delay, hour: '03:00+08:00' }, 'trash gc scheduled');
  };

  // 启动补跑：如果 03:00 时进程不在（重启/发版），过期板不必再等一整天。
  // 多副本同时启动时各跑一次，靠 DELETE 的行锁天然去重。
  void runTrashGcOnce().catch(() => undefined);
  schedule();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

const isDirectRun = Boolean(process.argv[1] && /trashGc\.(ts|js)$/.test(process.argv[1]));

if (isDirectRun) {
  purgeExpiredBoards()
    .then((purged) => {
      logger.info({ purged, retentionDays: TRASH_RETENTION_DAYS }, 'trash gc finished (manual)');
    })
    .catch((err: unknown) => {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'trash gc failed (manual)');
      process.exitCode = 1;
    })
    .finally(() => {
      void pool.end().catch(() => undefined);
    });
}
