drop index if exists workspace_invites_channel_idx;
alter table workspace_invites drop column if exists channel_id;
