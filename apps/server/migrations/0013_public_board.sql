-- ---------------------------------------------------------------
-- 公共临时板：所有未登录访客共用一块板
--
-- 归属约束原来要求 owner_id / owner_guest_id 恰好一个非空；公共板两者都为空
-- （不归属任何账号或浏览器），因此用 is_public 标记把它排除在约束之外。
-- 唯一索引保证全局最多只有一块公共板。
-- ---------------------------------------------------------------

alter table boards add column if not exists is_public boolean not null default false;

alter table boards drop constraint if exists boards_owner_exclusive_chk;
alter table boards add constraint boards_owner_exclusive_chk
  check ((owner_id is not null) <> (owner_guest_id is not null) or is_public);

create unique index if not exists boards_public_singleton_idx on boards (is_public) where is_public;
