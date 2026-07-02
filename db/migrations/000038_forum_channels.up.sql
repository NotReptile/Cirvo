-- Wave 9 (форум): пост форума = дочерний канал kind='thread' с parent_channel_id
-- на форум (kind='forum'). Сообщения/вложения/reactions/realtime работают
-- через существующую message-инфраструктуру без изменений — тред это
-- обычный канал. Заодно фундамент под треды в текстовых каналах (Wave 10).
alter table channels
  add column if not exists parent_channel_id uuid references channels(id) on delete cascade;

create index if not exists channels_parent_idx
  on channels(parent_channel_id)
  where parent_channel_id is not null;
