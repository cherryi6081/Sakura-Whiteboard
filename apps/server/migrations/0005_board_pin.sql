-- 「我的白板」置顶：置顶优先，其次最近打开。
-- pinned_at 可空、无默认值，老数据自动视为未置顶，不需要回填；
-- 排序只按 (pinned_at desc nulls last, last_edited_at desc)，数据量在 30 条/页以内，
-- 现有 boards_owner_recent_idx 已能覆盖 owner + last_edited_at，暂不额外建索引。
alter table boards add column if not exists pinned_at timestamptz;
