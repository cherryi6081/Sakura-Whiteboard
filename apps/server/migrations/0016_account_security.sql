-- 账号安全：找回密码 / 邮箱验证的一次性邮件令牌。
--
-- 口径：
-- - 只存 token 的 SHA-256，不落明文；明文只出现在发出去的邮件链接里。
-- - `consumed_at` 非空即视为已使用；过期与已使用的 token 都不可再次消费。
-- - 同一用户同一用途只保留最新一条有效令牌：签发新令牌时把旧的未消费行标记为已消费。
-- - 邮箱验证只写 `users.email_verified_at`，不参与登录/权限判定，未验证不影响老用户使用。

create table if not exists email_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users (id) on delete cascade,
  purpose     text not null check (purpose in ('password_reset', 'email_verify')),
  email       citext not null,
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  consumed_at timestamptz,
  created_at  timestamptz not null default now()
);

-- 按用户查最近一次令牌 / 签发新令牌时批量作废旧令牌
create index if not exists email_tokens_user_purpose_idx
  on email_tokens (user_id, purpose, created_at desc);

-- 过期清理与「未消费」筛选
create index if not exists email_tokens_expires_idx
  on email_tokens (expires_at)
  where consumed_at is null;
