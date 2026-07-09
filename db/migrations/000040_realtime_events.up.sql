create table if not exists realtime_events (
    seq bigserial primary key,
    event_id uuid not null unique,
    event_type text not null,
    workspace_id uuid null,
    channel_id uuid null,
    user_id uuid null,
    payload jsonb not null default '{}'::jsonb,
    occurred_at timestamptz not null default now(),
    published_at timestamptz null
);

create index if not exists idx_realtime_events_workspace_seq
    on realtime_events (workspace_id, seq)
    where workspace_id is not null;

create index if not exists idx_realtime_events_user_seq
    on realtime_events (user_id, seq)
    where user_id is not null;

create index if not exists idx_realtime_events_occurred_at
    on realtime_events (occurred_at);

