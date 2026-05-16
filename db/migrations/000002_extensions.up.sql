-- Extend users: add username (unique), display_name, updated_at
alter table users add column if not exists username text;
alter table users add column if not exists display_name text;
alter table users add column if not exists updated_at timestamptz not null default now();

update users set username = split_part(email, '@', 1) where username is null;
alter table users alter column username set not null;
create unique index if not exists users_username_unique on users (username);

-- Extend user_sessions: refresh expiry, last seen, user agent
alter table user_sessions add column if not exists refresh_expires_at timestamptz;
alter table user_sessions add column if not exists user_agent text;
alter table user_sessions add column if not exists last_seen_at timestamptz not null default now();
update user_sessions set refresh_expires_at = created_at + interval '30 days' where refresh_expires_at is null;
alter table user_sessions alter column refresh_expires_at set not null;
create index if not exists user_sessions_user_idx on user_sessions (user_id);
create unique index if not exists user_sessions_refresh_unique on user_sessions (refresh_token_hash);

-- Extend workspaces and channels
alter table workspaces add column if not exists updated_at timestamptz not null default now();
alter table channels add column if not exists topic text;
alter table channels add column if not exists position integer not null default 0;
alter table channels add column if not exists updated_at timestamptz not null default now();
create index if not exists channels_workspace_idx on channels (workspace_id);

-- Extend messages: idempotency, soft delete
alter table messages add column if not exists client_message_id text;
alter table messages add column if not exists deleted_at timestamptz;
create unique index if not exists messages_idempotent_unique
  on messages (channel_id, author_user_id, client_message_id)
  where client_message_id is not null;
create index if not exists messages_channel_created_idx on messages (channel_id, created_at desc);

-- Channel members ACL (optional override for private channels)
create table if not exists channel_members (
  channel_id uuid not null references channels(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (channel_id, user_id)
);

-- Message reactions
create table if not exists message_reactions (
  message_id uuid not null references messages(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  emoji text not null,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);

-- Indexes for invites and audit
create index if not exists workspace_invites_workspace_idx on workspace_invites (workspace_id);
create index if not exists audit_log_actor_idx on audit_log (actor_user_id);
create index if not exists audit_log_target_idx on audit_log (target_type, target_id);
