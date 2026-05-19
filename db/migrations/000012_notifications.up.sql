-- C.8 — in-app уведомления.
--
-- Две таблицы:
--   notification_jobs — очередь воркера. core-api на mention/reply/звонке
--     enqueue'ит сюда задачу, worker подхватывает (status='pending') и
--     раскладывает в user_notifications. Структура повторяет media_jobs
--     (см. 000006): SKIP LOCKED claim, attempts, scheduled_at для backoff.
--     Отдельная таблица (а не reuse media_jobs) — потому что media_jobs
--     ссылается на media_objects FK, а нам нужен generic payload jsonb.
--   user_notifications — итоговые записи, видимые юзеру через
--     /api/v1/notifications. payload содержит контекст события
--     (sourceKind, channelId, messageId, callId, actorId, snippet и т.п.).
--     read_at = null означает непрочитанное (для badge).

create table if not exists notification_jobs (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null,
  payload       jsonb not null,
  status        text not null default 'pending'
                check (status in ('pending', 'running', 'done', 'failed')),
  attempts      int  not null default 0,
  scheduled_at  timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  last_error    text,
  created_at    timestamptz not null default now()
);

create index if not exists notification_jobs_pending_idx
  on notification_jobs(scheduled_at)
  where status = 'pending';

create table if not exists user_notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  kind        text not null
              check (kind in ('mention', 'reply', 'call_incoming')),
  payload     jsonb not null,
  created_at  timestamptz not null default now(),
  read_at     timestamptz
);

create index if not exists user_notifications_user_idx
  on user_notifications(user_id, created_at desc);

-- Partial индекс для быстрого count(*) непрочитанных в badge.
create index if not exists user_notifications_unread_idx
  on user_notifications(user_id)
  where read_at is null;
