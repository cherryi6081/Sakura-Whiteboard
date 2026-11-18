import { logger } from '../infra/logger.js';
import { msUntilNextDaily } from '../domain/retention.js';

/**
 * API 进程内的每日定时任务（单机可靠、多实例由调用方自行加锁）。
 *
 * - 按 Asia/Shanghai 的固定时刻排下一次（不依赖容器时区）；
 * - 启动时默认先补跑一轮：进程在目标时刻不在线（重启/发版）时不必再等一整天；
 * - 进程内单飞：启动补跑与定时器不会重叠执行；
 * - `timer.unref()`：不让一个定时器把进程钉住（测试 / CLI 尤其重要）；
 * - 返回停止函数，供优雅退出时清理定时器。
 *
 * 多实例去重不在这里做：调用方的 `run` 应包一层 `withJobLock`，
 * 否则每个副本都会各跑一轮。
 */

export type DailyJobSpec = {
  name: string;
  /** Asia/Shanghai 的小时（0–23） */
  hour: number;
  minute?: number;
  /** 启动时是否立即补跑一次，默认 true */
  runOnStart?: boolean;
  run: () => Promise<void>;
};

export function startDailyJob(spec: DailyJobSpec): () => void {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  const tick = (): Promise<void> => {
    if (inFlight) return inFlight;
    inFlight = spec
      .run()
      .catch((err: unknown) => {
        logger.error(
          { job: spec.name, err: err instanceof Error ? err.message : String(err) },
          'scheduled job failed',
        );
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  const schedule = () => {
    if (stopped) return;
    const minute = spec.minute ?? 0;
    const delay = msUntilNextDaily(spec.hour, minute);
    timer = setTimeout(() => {
      void tick().finally(schedule);
    }, delay);
    timer.unref?.();
    logger.info(
      { job: spec.name, inMs: delay, at: `${String(spec.hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}+08:00` },
      'scheduled job registered',
    );
  };

  if (spec.runOnStart !== false) void tick();
  schedule();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
