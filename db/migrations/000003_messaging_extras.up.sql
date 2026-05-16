-- Read receipts: track last-read message per (user, channel)
create table if not exists read_receipts (
  channel_id uuid not null references channels(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  last_read_message_id uuid references messages(id) on delete set null,
  last_read_at timestamptz not null default now(),
  primary key (channel_id, user_id)
);

create index if not exists read_receipts_user_idx on read_receipts (user_id);
create index if not exists message_reactions_user_idx on message_reactions (user_id);
create index if not exists channel_members_user_idx on channel_members (user_id);
