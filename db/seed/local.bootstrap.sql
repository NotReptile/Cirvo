insert into users (id, email, password_hash)
values ('00000000-0000-0000-0000-000000000001', 'admin@local.rucord', 'bootstrap-change-me')
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
