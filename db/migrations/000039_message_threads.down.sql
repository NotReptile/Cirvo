drop index if exists channels_root_message_uidx;
alter table channels drop column if exists root_message_id;
