-- Кастомные роли воркспейса с union прав.
--
-- workspace_roles — справочник ролей per workspace. base_action_mask — text[]
-- массив action-кодов из internal/modules/permission. system=true для seed'нутых
-- owner/admin/moderator/member (их нельзя удалить и нельзя переименовать code,
-- остальное редактируемо).
--
-- workspace_role_members — many-to-many: юзер может иметь несколько ролей,
-- эффективные права = union base_action_mask всех ролей. workspace_members.
-- role_code остаётся как "primary role" для отображения (member-sidebar
-- группировка, цвет автора в сообщениях), но permission-резолвер сходит
-- в workspace_role_members.

create table if not exists workspace_roles (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  code text not null,
  name text not null,
  color text,
  position int not null default 0,
  hoisted boolean not null default false,
  base_action_mask text[] not null default '{}',
  system boolean not null default false,
  created_at timestamptz not null default now(),
  unique (workspace_id, code)
);
create index if not exists workspace_roles_ws_idx on workspace_roles (workspace_id);

create table if not exists workspace_role_members (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  role_id uuid not null references workspace_roles(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  primary key (role_id, user_id)
);
create index if not exists workspace_role_members_user_idx
  on workspace_role_members (workspace_id, user_id);

-- Backfill seeded roles для каждого существующего воркспейса. Position'ы
-- из иерархии (owner=1000, admin=100, moderator=50, member=10). Цвета — из
-- хардкод-палитры frontend'а; member без цвета (использует --text).
insert into workspace_roles (id, workspace_id, code, name, color, position, hoisted, base_action_mask, system)
select gen_random_uuid(), w.id, 'owner', 'Владелец', '#ed4245', 1000, true,
       array[
         'channel.create','channel.update','channel.delete','channel.manage_members',
         'message.moderate','invite.manage','audit.read','member.manage_role','member.kick',
         'message.write','message.react','message.attach','message.mention',
         'workspace.update'
       ], true
from workspaces w
on conflict (workspace_id, code) do nothing;

insert into workspace_roles (id, workspace_id, code, name, color, position, hoisted, base_action_mask, system)
select gen_random_uuid(), w.id, 'admin', 'Администратор', '#5865f2', 100, true,
       array[
         'channel.create','channel.update','channel.delete','channel.manage_members',
         'message.moderate','invite.manage','audit.read','member.manage_role','member.kick',
         'message.write','message.react','message.attach','message.mention',
         'workspace.update'
       ], true
from workspaces w
on conflict (workspace_id, code) do nothing;

insert into workspace_roles (id, workspace_id, code, name, color, position, hoisted, base_action_mask, system)
select gen_random_uuid(), w.id, 'moderator', 'Модератор', '#3ba55c', 50, true,
       array[
         'channel.create','channel.update','channel.delete','channel.manage_members',
         'message.moderate','invite.manage','audit.read','member.kick',
         'message.write','message.react','message.attach','message.mention'
       ], true
from workspaces w
on conflict (workspace_id, code) do nothing;

insert into workspace_roles (id, workspace_id, code, name, color, position, hoisted, base_action_mask, system)
select gen_random_uuid(), w.id, 'member', 'Участник', null, 10, false,
       array[
         'message.write','message.react','message.attach','message.mention'
       ], true
from workspaces w
on conflict (workspace_id, code) do nothing;

-- Заселяем workspace_role_members по существующим workspace_members.
insert into workspace_role_members (workspace_id, role_id, user_id)
select wm.workspace_id, wr.id, wm.user_id
from workspace_members wm
join workspace_roles wr on wr.workspace_id = wm.workspace_id and wr.code = wm.role_code
on conflict (role_id, user_id) do nothing;

-- channel_role_overrides переключается с role_code на role_id. role_code
-- оставляем nullable как backup на случай rollback'а: новый код пишет
-- ТОЛЬКО role_id, читает по role_id; старые строки без role_id всё ещё
-- читаются по role_code (но к моменту прогона миграции backfill обновил
-- все строки).
alter table channel_role_overrides add column if not exists role_id uuid;
-- Postgres UPDATE ... FROM запрещает ссылаться на target (cro) внутри JOIN-ON
-- для не-target таблиц. Переводим join в CROSS+WHERE.
update channel_role_overrides cro
set role_id = wr.id
from channels c, workspace_roles wr
where cro.channel_id = c.id
  and wr.workspace_id = c.workspace_id
  and wr.code = cro.role_code
  and cro.role_id is null;
alter table channel_role_overrides
  add constraint channel_role_overrides_role_fk
  foreign key (role_id) references workspace_roles(id) on delete cascade;
create index if not exists channel_role_overrides_role_idx
  on channel_role_overrides (role_id);
