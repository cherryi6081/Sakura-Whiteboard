-- 0010: board_ops 的 opId 唯一性从全库收到板内
--
-- 背景：`op_id` 原来是全库唯一。不同板复用同一个 opId 时，后到的 op 会命中
-- `on conflict (op_id) do nothing` 被静默吞掉，但客户端照样收到 ack，表现为
-- “这条 op 提交成功却查不到”。Redis 幂等键本来就是 `idem:{boardId}:{opId}`，
-- 这里把数据库的唯一性与应用层口径对齐为 (board_id, op_id)。
--
-- 迁移前置检查：跨板重复的 op_id 无法自动决定归属，直接报错交给人工处理。
-- 本地库实测（2026-11-12）：board_ops 共 77 行，跨板重复 op_id 0 条。

do $$
declare dup_count integer;
begin
  select count(*) into dup_count
    from (
      select op_id
        from board_ops
       group by op_id
      having count(distinct board_id) > 1
    ) d;
  if dup_count > 0 then
    raise exception 'board_ops 存在 % 个跨板重复 op_id，请先人工确认归属再迁移', dup_count;
  end if;
end $$;

alter table board_ops drop constraint if exists board_ops_op_id_key;
alter table board_ops
  add constraint board_ops_board_op_id_key unique (board_id, op_id);
