-- 「我的白板」回收站：软删除。
--
-- deleted_at 可空且无默认值，老数据自动视为未删除，不需要回填；
-- 列表/权限/配额查询统一追加 `deleted_at is null`，删除的板不再出现在任何正常入口。
-- 保留期由服务端定时任务按 deleted_at + 30 天清理（见 jobs/trashGc.ts），
-- 恢复只清空 deleted_at 并复用原 board id，分享链接与协作关系不变。
alter table boards add column if not exists deleted_at timestamptz;

-- 回收站列表：按 owner + 删除时间倒序；只索引已删除行，正常列表继续走 0002 的索引。
create index if not exists boards_owner_trash_idx on boards (owner_id, deleted_at desc)
  where deleted_at is not null;

-- 到期清理：只扫已删除行，避免全表扫描。
create index if not exists boards_trash_purge_idx on boards (deleted_at)
  where deleted_at is not null;
