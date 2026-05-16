drop index if exists workspace_invites_code_active_idx;
alter table workspace_invites drop column if exists created_at;
alter table workspace_invites drop column if exists created_by_user_id;

drop index if exists audit_log_workspace_idx;
alter table audit_log drop column if exists workspace_id;
