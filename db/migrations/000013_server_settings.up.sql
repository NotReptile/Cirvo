-- D.1 — server-wide настройки.
--
-- Две вещи:
--   1. users.is_root — флаг root-owner'а инстанса (он же admin админ-панели,
--      см. /api/v1/server/settings). Это НЕ workspace-роль owner — root один
--      на весь инстанс, выдаётся bootstrap'у или первому зарегистрировавшемуся.
--      Backfill: проставляем true самому раннему юзеру (если он есть).
--   2. server_settings — синглтон (id boolean primary key с check id=true),
--      хранит лимиты. Один insert default-значения. Без триггеров блокировки —
--      доступ через root-only API, дисциплинируем на уровне ручек.

alter table users
  add column if not exists is_root boolean not null default false;

update users
  set is_root = true
  where id = (select id from users order by created_at asc, id asc limit 1)
    and not exists (select 1 from users where is_root = true);

create table if not exists server_settings (
  id                            boolean primary key default true check (id = true),
  max_users                     integer not null default 0,
  max_workspaces                integer not null default 0,
  max_channels_per_workspace    integer not null default 0,
  max_message_bytes             integer not null default 8000,
  max_attachment_bytes          bigint  not null default 26214400, -- 25 MiB
  storage_quota_bytes           bigint  not null default 0,
  message_retention_days        integer not null default 0,
  registration_open             boolean not null default true,
  updated_at                    timestamptz not null default now(),
  updated_by_user_id            uuid references users(id) on delete set null
);

insert into server_settings (id) values (true)
  on conflict (id) do nothing;
