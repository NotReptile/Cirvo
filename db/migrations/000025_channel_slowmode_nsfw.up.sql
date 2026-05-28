-- J.3: per-channel slow-mode + 18+ флаг.
-- slow_mode_seconds: пауза между сообщениями одного юзера, 0 = без ограничения,
-- верхний потолок 21600 (6 часов) — sanity guard на случай битого PATCH'а.
-- is_nsfw: маркер «контент 18+», клиент при входе показывает overlay-confirm,
-- per-channel ack хранит сам клиент в localStorage.
alter table channels
  add column if not exists slow_mode_seconds int not null default 0,
  add column if not exists is_nsfw bool not null default false;

alter table channels
  add constraint channels_slow_mode_range_chk
    check (slow_mode_seconds >= 0 and slow_mode_seconds <= 21600);
