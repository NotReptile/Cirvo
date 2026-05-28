-- J.3(a): per-channel invites. Существующие workspace_invites расширяем
-- опциональным channel_id. NULL = workspace-scope (старое поведение):
-- accept делает только workspace_member. NOT NULL = channel-scope:
-- accept дополнительно делает channel_member если канал приватный
-- (для публичного — просто redirect на этот канал в UI).
alter table workspace_invites
  add column if not exists channel_id uuid
    references channels(id) on delete cascade;

create index if not exists workspace_invites_channel_idx
  on workspace_invites (channel_id) where channel_id is not null;
