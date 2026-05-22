drop index if exists users_avatar_media_idx;
alter table users drop column if exists avatar_media_id;
