-- ---------------------------------------------------------------
-- 0014：每日任务运行账本
--
-- 调度器在 API 进程内按 Asia/Shanghai 每日定点执行（见 jobs/dailySchedule.ts）。
-- 多副本部署时仅靠 advisory lock 只能保证"同一时刻只有一份在跑"；
-- 滚动发布 / 错峰重启时，第二个副本的启动补跑仍可能在任务完成后再次执行。
-- 这里按"上海自然日"记录最后一次成功运行，启动补跑与定时触发前先查账本：
-- 当天已成功跑过就跳过，跨天后照常运行。
--
-- 只在任务成功后写入；进程中途崩溃不会记账，后续补跑可重试（任务本身幂等）。
-- ---------------------------------------------------------------

create table if not exists job_runs (
  name        text primary key,
  last_run_at timestamptz not null default now()
);

comment on table job_runs is '每日定时任务的最后一次成功运行时间（按 Asia/Shanghai 自然日去重）';
