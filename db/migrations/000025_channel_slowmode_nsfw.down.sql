alter table channels drop constraint if exists channels_slow_mode_range_chk;
alter table channels drop column if exists slow_mode_seconds;
alter table channels drop column if exists is_nsfw;
