drop index if exists workspaces_avatar_media_idx;
alter table workspaces drop column if exists avatar_media_id;
