alter table channels drop constraint if exists channels_name_color_chk;
alter table channels drop column if exists archived_at;
alter table channels drop column if exists name_color;
