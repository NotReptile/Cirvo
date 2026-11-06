-- Presence: признак автоматического «Неактивен».
--
-- users.presence_auto_idle = true, когда режим idle выставлен клиентом
-- по таймеру неактивности (PUT /users/me/status с automatic=true), а не
-- вручную. Клиент по этому флагу понимает, что вернуть «В сети» нужно
-- при первом вводе, в том числе после перезапуска приложения и после
-- переподключения. Любая другая запись режима сбрасывает флаг.
alter table users
  add column if not exists presence_auto_idle boolean not null default false;
