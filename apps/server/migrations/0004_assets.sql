-- v1.1 图片资产（开发文档 §4.6 第二章）。编号按本次拍板使用 0004（设计稿旧编号 0009 作废）。
--
-- 归属约定沿用 boards：登录用户 uploader_id / 游客 uploader_guest_id **互斥且必有一个**。
-- 本版路由只允许登录用户上传（Q5），uploader_guest_id 预留给后续放开时不再改表。
-- 状态机：active --(GC 置 deleted_at)--> deleted --(对象删除后)--> purged_at 由 GC 回填。
-- sha256 用于同板秒传去重；storage_key 与 sha256 一一对应，因此并发重复上传写同一路径是幂等的。

create table if not exists assets (
  id                uuid primary key default gen_random_uuid(),
  board_id          text not null references boards (id) on delete cascade,
  uploader_id       uuid references users (id) on delete set null,
  uploader_guest_id text,
  mime              text not null check (mime in ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
  size_bytes        integer not null check (size_bytes > 0 and size_bytes <= 5 * 1024 * 1024),
  width             integer not null check (width > 0 and width <= 100000),
  height            integer not null check (height > 0 and height <= 100000),
  storage_key       text not null unique,
  sha256            char(64) not null check (sha256 ~ '^[a-f0-9]{64}$'),
  status            text not null default 'active' check (status in ('active', 'deleted')),
  created_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  purged_at         timestamptz,
  constraint assets_uploader_exclusive_chk
    check ((uploader_id is not null) <> (uploader_guest_id is not null)),
  constraint assets_deleted_consistency_chk
    check ((status = 'active' and deleted_at is null) or (status = 'deleted' and deleted_at is not null))
);

-- 同板同内容只保留一条 active 资产；置 deleted 后可重新上传（新 id，storage_key 相同，写入幂等）
create unique index if not exists assets_board_sha_active_uidx
  on assets (board_id, sha256)
  where status = 'active';

-- 按板列出资产（REST / 排障）
create index if not exists assets_board_created_idx
  on assets (board_id, created_at desc, id);

-- GC 扫描：只看仍占用对象的行
create index if not exists assets_gc_scan_idx
  on assets (created_at)
  where status = 'active' and purged_at is null;

-- 图片元素需要 `elements.type = 'image'`；0001 的 check 约束只允许 7 种内置图形
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'elements_type_check') then
    alter table elements drop constraint elements_type_check;
  end if;
  alter table elements add constraint elements_type_check
    check (type in ('rectangle', 'ellipse', 'diamond', 'arrow', 'text', 'freedraw', 'note', 'image'));
end $$;
