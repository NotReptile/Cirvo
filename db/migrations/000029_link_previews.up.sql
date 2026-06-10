-- Wave 2 — link-previews (OG-карточки под сообщением).
--
-- messages.link_previews — jsonb-массив (до 3) карточек
--   {url, title, description, imageUrl, siteName}.
-- Заполняется worker'ом асинхронно после создания/правки сообщения;
-- NULL = превью нет (URL отсутствуют / не отдали OG / ещё не обработано).
--
-- link_preview_jobs — очередь worker'а, повторяет паттерн notification_jobs
-- (SKIP LOCKED claim, attempts, scheduled_at backoff). payload не нужен —
-- worker сам перечитывает body сообщения (единый источник истины, правка
-- сообщения до обработки джобы даст превью уже нового текста).

alter table messages add column if not exists link_previews jsonb;

create table if not exists link_preview_jobs (
  id            uuid primary key default gen_random_uuid(),
  message_id    uuid not null references messages(id) on delete cascade,
  status        text not null default 'pending'
                check (status in ('pending', 'running', 'done', 'failed')),
  attempts      int  not null default 0,
  scheduled_at  timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  last_error    text,
  created_at    timestamptz not null default now()
);

create index if not exists link_preview_jobs_pending_idx
  on link_preview_jobs(scheduled_at)
  where status = 'pending';
