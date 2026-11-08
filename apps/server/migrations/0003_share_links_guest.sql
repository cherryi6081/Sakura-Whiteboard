-- M5-2：分享链接可由游客所有者签发（§4.7 决策 4）
-- 创建者二选一：登录用户 created_by / 游客 created_by_guest_id，
-- 与 boards.owner_id / owner_guest_id 的互斥约束保持一致。

alter table share_links alter column created_by drop not null;
alter table share_links add column if not exists created_by_guest_id text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'share_links_creator_exclusive_chk') then
    alter table share_links add constraint share_links_creator_exclusive_chk
      check ((created_by is not null) <> (created_by_guest_id is not null));
  end if;
end $$;
