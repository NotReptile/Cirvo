-- D.2 — Ban-флаг для админ-панели.
--
-- banned_at is null  → активный юзер;
-- banned_at not null → root забанил этого юзера.
-- При бане ниже на уровне core-api ревокируем сессии (set revoked_at = now()
-- в user_sessions) и блокируем login/refresh.
--
-- banned_reason — опциональный текст, показывается в админке и
-- (в будущем) можно показать самому юзеру при попытке логина.

alter table users
  add column if not exists banned_at timestamptz,
  add column if not exists banned_reason text;

create index if not exists users_banned_at_idx on users (banned_at)
  where banned_at is not null;
