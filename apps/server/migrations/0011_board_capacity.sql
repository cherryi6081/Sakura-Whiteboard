-- 白板列表容量 15 + 淘汰（用户明确规则，会删数据，必须可追溯）。
--
-- 1. 打开频次：列表页容量固定 15，超出时淘汰「打开次数最少、创建最早」的一块。
--    打开次数与最近打开时间由 POST /api/boards/:id/opened 单行累加写入；
--    两列都不进任何索引，避免每次打开都引起索引写放大。
-- 2. board_evictions：每次淘汰留一行审计（被淘汰的板、触发它的新板、排序口径、
--    当时的打开次数与创建时间、软删还是物理删），板被彻底清除后审计仍保留。

alter table boards add column if not exists opened_count integer not null default 0;
alter table boards add column if not exists last_opened_at timestamptz;

-- 非负兜底：计数只做 +1，出现负数说明写入路径有 bug
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'boards_opened_count_chk'
  ) then
    alter table boards add constraint boards_opened_count_chk check (opened_count >= 0);
  end if;
end $$;

-- 审计表不建外键：被淘汰的板可能在 30 天后被物理清除，审计必须能独立留存
create table if not exists board_evictions (
  id               bigserial primary key,
  board_id         text not null,
  board_title      text not null,
  owner_id         uuid,
  owner_guest_id   text,
  space_id         text,
  -- 触发本次淘汰的新板 id：把「谁把谁挤掉了」关联起来
  trigger_board_id text not null,
  -- 排序口径的快照，便于日后复核
  policy           text not null,
  opened_count     integer not null,
  last_opened_at   timestamptz,
  board_created_at timestamptz not null,
  -- trash = 登录用户软删进回收站；purged = 游客物理删除
  mode             text not null check (mode in ('trash', 'purged')),
  evicted_at       timestamptz not null default now()
);

create index if not exists board_evictions_owner_idx
  on board_evictions (owner_id, evicted_at desc);
create index if not exists board_evictions_guest_idx
  on board_evictions (owner_guest_id, evicted_at desc);
create index if not exists board_evictions_board_idx
  on board_evictions (board_id);
