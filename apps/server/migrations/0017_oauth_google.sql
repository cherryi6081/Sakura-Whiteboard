-- ---------------------------------------------------------------
-- 0017：第三方登录扩展到 Google
-- oauth_accounts.provider 原 check 只允许 github，加入 google。
-- 账号结构、唯一键与合并规则都沿用 0001 的定义，不新增表。
-- ---------------------------------------------------------------
alter table oauth_accounts drop constraint if exists oauth_accounts_provider_check;
alter table oauth_accounts
  add constraint oauth_accounts_provider_check check (provider in ('github', 'google'));
