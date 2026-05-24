-- H.8 — кастомный presence mode + custom status.
--
-- users.presence_mode — выбор юзера: 'online', 'idle', 'dnd', 'invisible'.
-- Дефолт 'online' — поведение до миграции (онлайн если есть свежая сессия).
-- 'invisible' маскируется на бэке: для других юзеров возвращается как
-- offline (online=false, presence_mode='offline'); для самого юзера в
-- /users/me — реальное значение.
--
-- users.custom_status — короткая строка типа «Играю в X», nullable.
-- Лимит длины валидируется на бэке (64 символа, как displayName).

alter table users
  add column if not exists presence_mode text not null default 'online'
    check (presence_mode in ('online', 'idle', 'dnd', 'invisible')),
  add column if not exists custom_status text;
