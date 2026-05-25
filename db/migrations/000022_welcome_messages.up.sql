-- H.9 — Welcome-канал + system-сообщения.
--
-- workspaces.welcome_channel_id (nullable) — куда писать «X присоединился».
-- ON DELETE SET NULL: удаление канала просто отключает приветствия,
-- остальной воркспейс не страдает. Не требуем text-kind через FK —
-- валидация на бэке (PUT /workspaces/{id}/welcome-channel проверяет kind).
--
-- messages.kind — расширение message-pipeline'а:
--   'user'                — обычное юзерское сообщение (дефолт);
--   'system_join'         — служебная плашка «X присоединился» (H.9);
--   'system_call'         — будущая плашка «звонок 02:34» (B.5 финал);
--   'system_channel_event'— реорг канала (создание/удаление/перемещение).
--
-- system-сообщения по convention'у:
--   author_user_id — кто стал причиной события (join → новый юзер);
--   body            — fallback-текст для старых клиентов, кто не знает kind.
--
-- Edit/delete/react для kind != 'user' блокируются на бэке (см. message/module.go).

alter table workspaces
  add column if not exists welcome_channel_id uuid
    references channels(id) on delete set null;

create index if not exists workspaces_welcome_channel_idx
  on workspaces (welcome_channel_id)
  where welcome_channel_id is not null;

alter table messages
  add column if not exists kind text not null default 'user'
    check (kind in ('user', 'system_join', 'system_call', 'system_channel_event'));
