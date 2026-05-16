-- Add workspace scope and timestamp to audit_log
alter table audit_log add column if not exists workspace_id uuid references workspaces(id) on delete set null;
create index if not exists audit_log_workspace_idx on audit_log (workspace_id, created_at desc);

-- Track invite metadata
alter table workspace_invites add column if not exists created_by_user_id uuid references users(id) on delete set null;
alter table workspace_invites add column if not exists created_at timestamptz not null default now();
create index if not exists workspace_invites_code_active_idx
  on workspace_invites (code)
  where revoked_at is null;
