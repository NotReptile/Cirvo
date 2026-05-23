drop index if exists channel_role_overrides_role_idx;
alter table channel_role_overrides drop constraint if exists channel_role_overrides_role_fk;
alter table channel_role_overrides drop column if exists role_id;

drop index if exists workspace_role_members_user_idx;
drop table if exists workspace_role_members;
drop index if exists workspace_roles_ws_idx;
drop table if exists workspace_roles;
