-- 「我的白板」拖拽排序：按用户保存手动顺序（设计稿 boards-drag-sort §02 / §3.2）。
--
-- 为什么要两张表而不是 boards.sort_order：
--   rank 是「每个用户自己的列表偏好」，不是白板属性。存 boards 上会让协作者
--   互相覆盖顺序；存 (user_id, board_id) 则各排各的，也不需要「置顶仅 owner 可改」
--   的权限特例——排序不校验角色，置顶仍走 boards.pinned_at。
--
-- 为什么不在 boards 上加 rank 列，也不回填历史数据：
--   默认模式是 auto，此时 rank 完全不参与排序，上线首日与现在逐字节一致；
--   只有用户第一次拖动后才会写入 rank，并按组（置顶 / 普通）分别接管。
--
-- rank 用 numeric(20,8) 而非整数：接口传的是「邻居」而不是「第几位」，
-- 服务端取两个邻居的中点（初始步长 1024），间隙不足时整组按 1024 重排。
create table if not exists board_user_order (
  user_id uuid not null references users (id) on delete cascade,
  board_id text not null references boards (id) on delete cascade,
  rank numeric(20, 8) not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, board_id)
);

create index if not exists board_user_order_user_rank_idx
  on board_user_order (user_id, rank);

-- 排序模式按用户存：auto = 保持「置顶优先 + 最近编辑」，manual = 组内按 rank。
-- 没有记录等同于 auto，因此不需要给存量用户插入行。
create table if not exists board_user_settings (
  user_id uuid primary key references users (id) on delete cascade,
  sort_mode text not null default 'auto' check (sort_mode in ('auto', 'manual')),
  updated_at timestamptz not null default now()
);
