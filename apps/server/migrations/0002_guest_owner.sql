-- ---------------------------------------------------------------
-- 0002：游客归属（M5-1）
--
-- 设计见开发文档 §4.7：owner_id 可空 + owner_guest_id 互斥；
-- 两个部分索引分别支撑"我的板"（登录用户）与"本机临时板"（游客）查询。
-- 必须在"游客建板接口"上线前应用；已有数据（owner_id 非空、owner_guest_id 为空）满足新约束。
-- ---------------------------------------------------------------

-- 1) 允许游客归属：owner_id 可空 + 新增 owner_guest_id
alter table boards alter column owner_id drop not null;
alter table boards add column if not exists owner_guest_id text;

-- 2) 恰好一个归属者（互斥）
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'boards_owner_exclusive_chk'
  ) then
    alter table boards add constraint boards_owner_exclusive_chk
      check ((owner_id is not null) <> (owner_guest_id is not null));
  end if;
end $$;

-- 3) 部分索引：登录用户"我的板"与游客临时板
drop index if exists boards_owner_recent_idx;
create index boards_owner_recent_idx on boards (owner_id, last_edited_at desc)
  where owner_id is not null;

create index if not exists boards_owner_guest_idx on boards (owner_guest_id, last_edited_at desc)
  where owner_guest_id is not null;

-- 文档 §4.7 草案里的 boards_owner_idx 与 boards_owner_recent_idx 语义重复；
-- 这里统一用既有名字 boards_owner_recent_idx（部分索引），不再新增冗余索引。
drop index if exists boards_owner_idx;
