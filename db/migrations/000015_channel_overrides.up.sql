-- D.4 — Per-channel permission overrides.
--
-- Effective(user, channel, action) =
--   (workspace_role_can(role, action) ∪ granted_actions)  −  denied_actions
--
-- Per (channel, role_code) ровно одна запись с двумя массивами action-кодов.
-- Owner и admin не управляются overrides — иначе они могли бы запереть сами
-- себя из канала. См. permission.AuthorizeChannel для семантики.
--
-- granted/denied — text[], а не отдельные таблицы junction'а: action-коды
-- стабильные string-литералы из permission/permission.go, никаких FK
-- не нужно. Невалидные коды просто игнорируются на чтении.

create table if not exists channel_role_overrides (
  channel_id        uuid not null references channels(id) on delete cascade,
  role_code         text not null,
  granted_actions   text[] not null default '{}',
  denied_actions    text[] not null default '{}',
  updated_at        timestamptz not null default now(),
  updated_by_user_id uuid references users(id) on delete set null,
  primary key (channel_id, role_code)
);

create index if not exists channel_role_overrides_channel_idx
  on channel_role_overrides (channel_id);
