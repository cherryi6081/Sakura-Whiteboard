-- 团队空间（设计稿「我的白板 · 团队空间切换」§09 P0）。
--
-- 三件事一次建好：
--   1. `spaces` 同时承载个人空间与团队空间，个人空间一人一个（部分唯一索引兜底）；
--   2. `space_members` 是**唯一的权限来源**，角色 owner / editor / viewer；
--   3. `boards.space_id` 让白板归属空间，旧板全部回填到创建者的个人空间。
--
-- 为什么不用 `kind='personal'` 的固定 id：空间 id 会进 URL（?space=sp_xxx），
-- 也不能被枚举；个人空间同样是随机 id，只是每人一条并加唯一约束。

create table if not exists spaces (
  id         text primary key check (id ~ '^sp_[A-Za-z0-9_-]{10,32}$'),
  kind       text not null check (kind in ('personal', 'team')),
  name       text not null check (char_length(name) between 1 and 40),
  avatar_key text,
  owner_id   uuid not null references users (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- 一个用户只能有一个个人空间；团队空间不限制创建数量
create unique index if not exists spaces_one_personal_per_user
  on spaces (owner_id) where kind = 'personal' and deleted_at is null;
create index if not exists spaces_owner_kind_idx on spaces (owner_id, kind);

create table if not exists space_members (
  space_id   text not null references spaces (id) on delete cascade,
  user_id    uuid not null references users (id) on delete cascade,
  role       text not null check (role in ('owner', 'editor', 'viewer')),
  invited_by uuid references users (id) on delete set null,
  joined_at  timestamptz not null default now(),
  primary key (space_id, user_id)
);

-- 最后一个所有者不可降级 / 移除：靠「每个空间最多一个 owner」在库里强校验
create unique index if not exists space_members_one_owner
  on space_members (space_id) where role = 'owner';
create index if not exists space_members_user_idx on space_members (user_id, joined_at);

create table if not exists space_invites (
  token      text primary key,
  space_id   text not null references spaces (id) on delete cascade,
  role       text not null check (role in ('editor', 'viewer')),
  created_by uuid not null references users (id) on delete cascade,
  expires_at timestamptz not null default now() + interval '7 days',
  revoked_at timestamptz,
  max_uses   integer check (max_uses is null or max_uses > 0),
  used_count integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists space_invites_space_idx
  on space_invites (space_id, created_at desc);

-- 游客板（owner_guest_id）没有空间，保持 null；登录用户的板由下面回填
alter table boards add column if not exists space_id text references spaces (id) on delete set null;
create index if not exists boards_space_recent_idx
  on boards (space_id, last_edited_at desc) where deleted_at is null;

-- 回填 1：给每个已有用户建个人空间（id 由 uuid 派生，可重复执行）
insert into spaces (id, kind, name, owner_id)
select 'sp_' || replace(u.id::text, '-', ''), 'personal', left(u.display_name, 40), u.id
  from users u
 where not exists (
   select 1 from spaces s
    where s.owner_id = u.id and s.kind = 'personal' and s.deleted_at is null
 );

-- 回填 2：个人空间的所有者成员行
insert into space_members (space_id, user_id, role)
select s.id, s.owner_id, 'owner'
  from spaces s
 where s.kind = 'personal'
on conflict (space_id, user_id) do nothing;

-- 回填 3：登录用户的历史白板（含回收站里的）归入自己的个人空间
update boards b
   set space_id = s.id
  from spaces s
 where b.space_id is null
   and b.owner_id = s.owner_id
   and s.kind = 'personal'
   and s.deleted_at is null;
