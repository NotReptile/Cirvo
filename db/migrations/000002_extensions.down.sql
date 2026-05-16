drop table if exists message_reactions;
drop table if exists channel_members;

drop index if exists messages_channel_created_idx;
drop index if exists messages_idempotent_unique;
alter table messages drop column if exists deleted_at;
alter table messages drop column if exists client_message_id;

drop index if exists channels_workspace_idx;
alter table channels drop column if exists updated_at;
alter table channels drop column if exists position;
alter table channels drop column if exists topic;
alter table workspaces drop column if exists updated_at;

drop index if exists user_sessions_refresh_unique;
drop index if exists user_sessions_user_idx;
alter table user_sessions drop column if exists last_seen_at;
alter table user_sessions drop column if exists user_agent;
alter table user_sessions drop column if exists refresh_expires_at;

drop index if exists users_username_unique;
alter table users drop column if exists updated_at;
alter table users drop column if exists display_name;
alter table users drop column if exists username;

drop index if exists workspace_invites_workspace_idx;
drop index if exists audit_log_actor_idx;
drop index if exists audit_log_target_idx;
