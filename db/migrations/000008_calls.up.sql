-- История звонков. 1-к-1 пишет одну запись на звонок (общий call_id у
-- обоих пиров); voice_channel сценарий пока не пишет — это породило бы
-- много шума, типа «X был 30 мин в #voice» (в Discord этого тоже нет в
-- чат-истории, только activity-фид). Колонка kind оставлена на будущее.
create table if not exists calls (
  id                 uuid primary key,
  kind               text not null check (kind in ('one_to_one', 'voice_channel')),
  initiator_user_id  uuid not null references users(id) on delete cascade,
  peer_user_id       uuid references users(id) on delete set null,
  channel_id         uuid references channels(id) on delete set null,
  started_at         timestamptz not null default now(),
  ended_at           timestamptz,
  reason             text
);

create index if not exists calls_initiator_idx on calls(initiator_user_id, started_at desc);
create index if not exists calls_peer_idx on calls(peer_user_id, started_at desc);
create index if not exists calls_channel_idx on calls(channel_id, started_at desc);
