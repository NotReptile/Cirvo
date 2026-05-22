drop index if exists dm_channels_user_b_idx;
drop index if exists dm_channels_user_a_idx;
drop index if exists dm_channels_pair_uniq;
drop table if exists dm_channels;
-- workspace_id обратно not null — только если DM-каналов нет в БД. На
-- свежей базе и в CI это true; в проде down не используется.
alter table channels alter column workspace_id set not null;
