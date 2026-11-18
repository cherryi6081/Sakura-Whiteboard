import { pool } from '../infra/db.js';

/**
 * 每日任务账本：按 Asia/Shanghai 自然日判断"今天是否已经成功跑过"。
 *
 * 与 `withJobLock` 的分工：
 * - advisory lock 解决**同一时刻**多副本抢跑；
 * - 账本解决**滚动发布 / 错峰重启**时启动补跑在任务完成后再跑一遍。
 *
 * 只记录成功完成的任务（调用方在 `run()` 成功返回后写），
 * 中途崩溃不会记账，后续启动仍可补跑；任务本身均幂等。
 */

export async function hasRunToday(name: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `select 1
       from job_runs
      where name = $1
        and (last_run_at at time zone 'Asia/Shanghai')::date = (now() at time zone 'Asia/Shanghai')::date`,
    [name],
  );
  return (rowCount ?? 0) > 0;
}

export async function markRunCompleted(name: string): Promise<void> {
  await pool.query(
    `insert into job_runs (name, last_run_at) values ($1, now())
     on conflict (name) do update set last_run_at = excluded.last_run_at`,
    [name],
  );
}
