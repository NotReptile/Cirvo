-- Background jobs for media post-processing.
create table if not exists media_jobs (
  id uuid primary key,
  media_id uuid not null references media_objects(id) on delete cascade,
  kind text not null,
  status text not null default 'pending', -- pending | running | done | failed
  attempts integer not null default 0,
  last_error text,
  scheduled_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists media_jobs_pending_idx
  on media_jobs (scheduled_at)
  where status = 'pending';

create index if not exists media_jobs_media_idx
  on media_jobs (media_id);

-- Thumbnail metadata on the source media row.
alter table media_objects add column if not exists thumbnail_object_key text;
alter table media_objects add column if not exists thumbnail_width integer;
alter table media_objects add column if not exists thumbnail_height integer;
