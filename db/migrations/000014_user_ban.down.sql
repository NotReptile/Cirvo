drop index if exists users_banned_at_idx;
alter table users drop column if exists banned_reason;
alter table users drop column if exists banned_at;
