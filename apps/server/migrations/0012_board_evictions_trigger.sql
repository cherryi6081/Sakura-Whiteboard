-- 恢复白板时的确认式替换：区分淘汰是「新建第 13 块触发」还是「回收站恢复触发」。
--
-- 恢复本身不删数据，但满 12 块时要在同一事务里把用户选中的一块移入回收站。
-- 审计沿用 0011 的 board_evictions，只加触发来源，便于排查「谁的板被谁挤掉」。

alter table board_evictions add column if not exists trigger text not null default 'create';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'board_evictions_trigger_chk'
  ) then
    alter table board_evictions
      add constraint board_evictions_trigger_chk check (trigger in ('create', 'restore'));
  end if;
end $$;
