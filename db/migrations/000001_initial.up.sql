create table if not exists users (
  id uuid primary key,
  email text not null unique,
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists user_sessions (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  refresh_token_hash text not null,
  device_label text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table if not exists workspaces (
  id uuid primary key,
  slug text not null unique,
  name text not null,
  owner_user_id uuid not null references users(id),
  created_at timestamptz not null default now()
);

create table if not exists workspace_members (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role_code text not null,
  joined_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table if not exists channels (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  kind text not null,
  name text not null,
  is_private boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists messages (
  id uuid primary key,
  channel_id uuid not null references channels(id) on delete cascade,
  author_user_id uuid not null references users(id),
  body text not null,
  created_at timestamptz not null default now(),
  edited_at timestamptz
);

create table if not exists workspace_invites (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  code text not null unique,
  max_uses integer not null default 1,
  used_count integer not null default 0,
  expires_at timestamptz,
  revoked_at timestamptz
);

create table if not exists upload_sessions (
  id uuid primary key,
  object_key text not null unique,
  content_type text not null,
  size_bytes bigint not null,
  created_by_user_id uuid not null references users(id),
  created_at timestamptz not null default now()
);

create table if not exists audit_log (
  id uuid primary key,
  actor_user_id uuid references users(id),
  action_code text not null,
  target_type text not null,
  target_id text not null,
  created_at timestamptz not null default now()
);
