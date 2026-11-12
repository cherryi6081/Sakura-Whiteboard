-- 0009: 用户软删（users.status = 'disabled'），同时让硬删用户被数据库拒绝
--
-- 语义：`users.status` 取 `active | disabled`。把账号置为 `disabled` 即为“注销”：
-- 不能登录、已有会话立即失效；但 board_ops / assets / boards / spaces / 成员关系
-- 全部保留，历史归属仍可追溯（board_ops.user_id、assets.uploader_id 不丢）。
--
-- 为满足“硬删在数据库层就不可能发生”，以下会删掉业务数据的外键由
-- SET NULL / CASCADE 改为 RESTRICT：
--   board_ops.user_id      原 SET NULL：软删后归属丢失，且会撞 board_ops_identity_chk
--   assets.uploader_id     原 SET NULL：资产归属丢失
--   boards.owner_id        原 CASCADE ：删用户会连带删掉他的所有白板
--   spaces.owner_id        原 CASCADE ：删用户会删掉个人空间与他拥有的团队空间
--   space_members.user_id  原 CASCADE ：删用户会静默改写团队成员/角色结构
--   board_members.user_id  原 CASCADE ：白板级成员关系同样需要保留
--   share_links.created_by 原 CASCADE ：分享链接是业务数据，不随账号消失
--
-- 账号私有数据（credentials / oauth_accounts / board_user_order /
-- board_user_settings）保持 CASCADE：没有业务价值，真正清号时可由人工先删。
-- space_invites.created_by 仍为 CASCADE：邀请是 7 天有效的临时凭据。

alter table board_ops drop constraint if exists board_ops_user_id_fkey;
alter table board_ops
  add constraint board_ops_user_id_fkey
  foreign key (user_id) references users (id) on delete restrict;

alter table assets drop constraint if exists assets_uploader_id_fkey;
alter table assets
  add constraint assets_uploader_id_fkey
  foreign key (uploader_id) references users (id) on delete restrict;

alter table boards drop constraint if exists boards_owner_id_fkey;
alter table boards
  add constraint boards_owner_id_fkey
  foreign key (owner_id) references users (id) on delete restrict;

alter table spaces drop constraint if exists spaces_owner_id_fkey;
alter table spaces
  add constraint spaces_owner_id_fkey
  foreign key (owner_id) references users (id) on delete restrict;

alter table space_members drop constraint if exists space_members_user_id_fkey;
alter table space_members
  add constraint space_members_user_id_fkey
  foreign key (user_id) references users (id) on delete restrict;

alter table board_members drop constraint if exists board_members_user_id_fkey;
alter table board_members
  add constraint board_members_user_id_fkey
  foreign key (user_id) references users (id) on delete restrict;

alter table share_links drop constraint if exists share_links_created_by_fkey;
alter table share_links
  add constraint share_links_created_by_fkey
  foreign key (created_by) references users (id) on delete restrict;
