-- Wave 4 — персистентные настройки уведомлений (G.9.e / I.8b).
--
-- Уровни: 'all' (всё), 'mentions' (только @упоминания/ответы),
-- 'none' (полный mute). Отсутствие строки = унаследовать:
--   канал ← воркспейс ← дефолт 'all'.
-- Enforcement: worker (NotificationRunner) не раскладывает mention/reply
-- для получателей с эффективным 'none'; клиент глушит unread-badge и
-- browser-popup'ы.

create table if not exists user_channel_preferences (
  user_id     uuid not null references users(id) on delete cascade,
  channel_id  uuid not null references channels(id) on delete cascade,
  level       text not null check (level in ('all', 'mentions', 'none')),
  updated_at  timestamptz not null default now(),
  primary key (user_id, channel_id)
);

create table if not exists user_workspace_preferences (
  user_id       uuid not null references users(id) on delete cascade,
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  level         text not null check (level in ('all', 'mentions', 'none')),
  updated_at    timestamptz not null default now(),
  primary key (user_id, workspace_id)
);
