-- 申请编辑权限（分享协作文档 §权限申请）。
--
-- 场景：访客通过只读分享链接进入白板后，可以向前所有者申请可写权限；
-- 所有者批准后，申请人通过 `board_members(editor)` 获得编辑权，判定仍走 `domain/access.ts`，
-- 不引入平行的权限模型（不直接改 `share_links`，也不改 `boards.share_mode`）。
--
-- 状态机：pending → approved | rejected。只对 `pending` 建部分唯一索引：
-- 同一人重复申请只更新既有待处理行，不会堆出多条；被拒绝后可以重新申请（新行）。

create table if not exists board_edit_requests (
  id           uuid primary key default gen_random_uuid(),
  board_id     text not null references boards (id) on delete cascade,
  requester_id uuid not null references users (id) on delete cascade,
  note         text check (note is null or char_length(note) <= 200),
  status       text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  decided_by   uuid references users (id) on delete set null,
  decided_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- 同一白板 + 同一申请人最多一条待处理申请（并发提交靠它兜底）
create unique index if not exists board_edit_requests_pending_uidx
  on board_edit_requests (board_id, requester_id)
  where status = 'pending';

-- 所有者查看待处理列表 / 申请人查看自己的最近一条
create index if not exists board_edit_requests_board_status_idx
  on board_edit_requests (board_id, status, created_at desc);

create index if not exists board_edit_requests_requester_idx
  on board_edit_requests (requester_id, created_at desc);
