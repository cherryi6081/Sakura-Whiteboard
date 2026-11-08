create extension if not exists pgcrypto;
create extension if not exists citext;

-- ---------------------------------------------------------------
-- users：身份容器，不存任何凭据
-- ---------------------------------------------------------------
create table if not exists users (
  id               uuid primary key default gen_random_uuid(),
  email            citext,
  display_name     text not null check (char_length(display_name) between 2 and 24),
  avatar_url       text,
  color            text not null default '#A85C7C',
  status           text not null default 'active' check (status in ('active', 'disabled')),
  email_verified_at timestamptz,
  created_at       timestamptz not null default now(),
  last_login_at    timestamptz
);

-- 部分唯一索引：允许 email 为空的 OAuth-only 账号存在多个
create unique index if not exists users_email_uidx on users (email) where email is not null;
create index if not exists users_last_login_idx on users (last_login_at desc);

-- ---------------------------------------------------------------
-- credentials：一个用户最多一条密码凭据（user_id 作主键即唯一约束）
-- ---------------------------------------------------------------
create table if not exists credentials (
  user_id      uuid primary key references users (id) on delete cascade,
  password_hash text not null,
  updated_at   timestamptz not null default now(),
  last_used_at timestamptz
);

-- ---------------------------------------------------------------
-- oauth_accounts：一个用户可绑多条；同一 provider 账号只能绑一个用户
-- ---------------------------------------------------------------
create table if not exists oauth_accounts (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references users (id) on delete cascade,
  provider               text not null check (provider in ('github')),
  provider_user_id       text not null,
  provider_email         citext,
  provider_email_verified boolean not null default false,
  scopes                 text,
  linked_at              timestamptz not null default now(),
  last_used_at           timestamptz,
  unique (provider, provider_user_id)
);

create index if not exists oauth_accounts_user_idx on oauth_accounts (user_id);

-- ---------------------------------------------------------------
-- boards
-- ---------------------------------------------------------------
create table if not exists boards (
  id             text primary key check (id ~ '^[A-Za-z0-9_-]{12}$'),
  title          text not null check (char_length(title) between 1 and 80),
  owner_id       uuid not null references users (id) on delete cascade,
  share_mode     text not null default 'private' check (share_mode in ('private', 'link_read', 'link_edit')),
  last_seq       bigint not null default 0,
  last_edited_at timestamptz not null default now(),
  thumbnail_url  text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  archived_at    timestamptz
);

create index if not exists boards_owner_recent_idx on boards (owner_id, last_edited_at desc);
create index if not exists boards_recent_idx on boards (last_edited_at desc);

-- ---------------------------------------------------------------
-- board_members：登录协作者（owner 由 boards.owner_id 表达，不在此重复）
-- ---------------------------------------------------------------
create table if not exists board_members (
  board_id   text not null references boards (id) on delete cascade,
  user_id    uuid not null references users (id) on delete cascade,
  role       text not null check (role in ('editor', 'viewer')),
  added_by   uuid,
  created_at timestamptz not null default now(),
  primary key (board_id, user_id)
);

create index if not exists board_members_user_idx on board_members (user_id, created_at desc);

-- ---------------------------------------------------------------
-- share_links：凭链接访问；库内存哈希，不存明文 token
-- ---------------------------------------------------------------
create table if not exists share_links (
  id         uuid primary key default gen_random_uuid(),
  board_id   text not null references boards (id) on delete cascade,
  token_hash text not null unique,
  permission text not null check (permission in ('read', 'edit')),
  created_by uuid not null references users (id) on delete cascade,
  expires_at timestamptz,
  revoked_at timestamptz,
  use_count  integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists share_links_board_idx on share_links (board_id, revoked_at);

-- ---------------------------------------------------------------
-- elements：当前态（LWW 字段 + 分数索引 + 墓碑）
-- ---------------------------------------------------------------
create table if not exists elements (
  board_id      text not null references boards (id) on delete cascade,
  element_id    text not null,
  type          text not null check (type in ('rectangle', 'ellipse', 'diamond', 'arrow', 'text', 'freedraw', 'note')),
  version       integer not null default 1 check (version > 0),
  version_nonce integer not null,
  zindex_key    text not null,
  is_deleted    boolean not null default false,
  data          jsonb not null default '{}'::jsonb,
  updated_by    uuid references users (id) on delete set null,
  updated_at    timestamptz not null default now(),
  primary key (board_id, element_id)
);

create index if not exists elements_board_z_idx on elements (board_id, zindex_key);
create index if not exists elements_board_updated_idx on elements (board_id, updated_at);

-- ---------------------------------------------------------------
-- board_ops：追加日志（seq 由 Redis INCR 分配，op_id 做幂等）
-- ---------------------------------------------------------------
create table if not exists board_ops (
  board_id   text not null references boards (id) on delete cascade,
  seq        bigint not null check (seq > 0),
  op_id      text not null unique,
  client_id  text not null,
  user_id    uuid references users (id) on delete set null,
  guest_id   text,
  kind       text not null check (kind in ('upsert', 'delete', 'zindex')),
  element_id text not null,
  payload    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (board_id, seq),
  constraint board_ops_identity_chk check (user_id is not null or guest_id is not null)
);

create index if not exists board_ops_created_idx on board_ops (board_id, created_at);

-- ---------------------------------------------------------------
-- board_snapshots：压缩点（每板保留最近 5 份）
-- ---------------------------------------------------------------
create table if not exists board_snapshots (
  board_id   text not null references boards (id) on delete cascade,
  seq        bigint not null,
  state      jsonb not null,
  created_at timestamptz not null default now(),
  primary key (board_id, seq)
);
