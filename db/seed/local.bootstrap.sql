-- Bootstrap user. The password_hash here is an intentional placeholder so the
-- account cannot be used to log in. Re-register or set a real bcrypt hash to
-- activate it.
insert into users (id, email, username, display_name, password_hash)
values (
  '00000000-0000-0000-0000-000000000001',
  'admin@local.rucord',
  'admin',
  'Bootstrap Admin',
  '$2a$12$bootstrap-placeholder-not-a-real-bcrypt-hash--------'
)
on conflict (email) do nothing;

insert into workspaces (id, slug, name, owner_user_id)
values (
  '10000000-0000-0000-0000-000000000001',
  'bootstrap',
  'Bootstrap Workspace',
  '00000000-0000-0000-0000-000000000001'
)
on conflict (slug) do nothing;

insert into workspace_members (workspace_id, user_id, role_code)
values (
  '10000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  'owner'
)
on conflict (workspace_id, user_id) do nothing;

insert into channels (id, workspace_id, kind, name, is_private, position)
values (
  '20000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'text',
  'general',
  false,
  0
)
on conflict (id) do nothing;
