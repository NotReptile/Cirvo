drop index if exists channels_parent_idx;
alter table channels drop column if exists parent_channel_id;
