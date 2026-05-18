-- Voice-каналы: кто сейчас «в звонке». Одна запись = одна сессия юзера
-- в одном voice-канале. PK по (channel_id, session_id), чтобы один и
-- тот же логин с двух устройств давал два слота — это разные WebRTC
-- эндпоинты, их надо различать.
create table if not exists channel_participants (
  channel_id uuid not null references channels(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  session_id uuid not null references user_sessions(id) on delete cascade,
  joined_at  timestamptz not null default now(),
  primary key (channel_id, session_id)
);

create index if not exists channel_participants_channel_idx on channel_participants(channel_id);
create index if not exists channel_participants_user_idx on channel_participants(user_id);
