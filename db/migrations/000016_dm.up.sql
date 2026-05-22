-- G.8 — DM (личные сообщения).
--
-- channels.workspace_id становится nullable: DM-каналы существуют вне
-- воркспейса (отдельная сущность в UI «Личные сообщения», вне ws-rail'а).
-- Воркспейсовые каналы остаются с not-null workspace_id на уровне приложения
-- (channel.handleCreate всегда выставляет его); DB-уровень ослабляется только
-- чтобы DM-row мог иметь NULL.
--
-- Отдельная таблица dm_channels хранит нормализованную пару (user_a < user_b)
-- с unique-индексом — один DM на пару. channel_members параллельно содержит
-- обе записи (для consistent ACL через channel.Resolve и list-членов).
--
-- kind='dm' валидируется приложением (allowedKinds в channel/module.go +
-- dm/module.go), на уровне БД kind остаётся свободным text-полем.

alter table channels alter column workspace_id drop not null;

create table if not exists dm_channels (
  channel_id uuid primary key references channels(id) on delete cascade,
  user_a     uuid not null references users(id) on delete cascade,
  user_b     uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  check (user_a < user_b)
);

create unique index if not exists dm_channels_pair_uniq on dm_channels (user_a, user_b);
create index if not exists dm_channels_user_a_idx     on dm_channels (user_a);
create index if not exists dm_channels_user_b_idx     on dm_channels (user_b);
