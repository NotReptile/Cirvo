-- Принудительная смена пароля при первом входе.
--
-- Админ создаёт пользователя с временным паролем (POST /api/v1/server/users),
-- флаг must_change_password = true. Пока пользователь не сменил пароль,
-- core-api отвечает 403 password_change_required на все запросы, кроме
-- смены пароля, GET /users/me и logout (см. app.Authenticator.Middleware).
-- Смена пароля (POST /users/me/password) сбрасывает флаг.

alter table users
  add column if not exists must_change_password boolean not null default false;
