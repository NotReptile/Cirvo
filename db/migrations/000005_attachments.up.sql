-- Persistent record of an uploaded object in MinIO.
create table if not exists media_objects (
  id uuid primary key,
  object_key text not null unique,
  bucket text not null,
  content_type text not null,
  size_bytes bigint not null,
  original_filename text,
  uploaded_by_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists media_objects_uploader_idx on media_objects (uploaded_by_user_id);

-- Many-to-many between messages and media_objects.
create table if not exists message_attachments (
  message_id uuid not null references messages(id) on delete cascade,
  media_id uuid not null references media_objects(id) on delete cascade,
  position integer not null default 0,
  primary key (message_id, media_id)
);

create index if not exists message_attachments_media_idx on message_attachments (media_id);
create index if not exists message_attachments_message_idx on message_attachments (message_id, position);

-- Augment existing upload_sessions for status tracking.
alter table upload_sessions add column if not exists media_id uuid references media_objects(id) on delete set null;
alter table upload_sessions add column if not exists status text not null default 'completed';
alter table upload_sessions add column if not exists completed_at timestamptz;
