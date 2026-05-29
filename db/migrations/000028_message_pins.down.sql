drop index if exists messages_pinned_idx;
alter table messages
  drop column if exists pinned_by,
  drop column if exists pinned_at,
  drop column if exists is_pinned;
