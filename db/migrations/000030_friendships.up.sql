-- Wave 3 — друзья, блокировки, приватные заметки.
--
-- friendships: нормализованная пара (user_a < user_b, как dm_channels),
-- одна строка на пару. status:
--   pending  — заявка; requested_by показывает, кто отправил.
--   accepted — друзья.
--   blocked  — блокировка; requested_by = кто заблокировал. Снятие блока
--              удаляет строку целиком. MVP-упрощение: если оба блокировали
--              друг друга, хранится только последний блокировщик — unblock
--              одним снимает блок для обоих (редкий кейс, терпимо).
--
-- user_notes: приватные заметки «про юзера» — видны только владельцу.

create table if not exists friendships (
  user_a        uuid not null references users(id) on delete cascade,
  user_b        uuid not null references users(id) on delete cascade,
  status        text not null check (status in ('pending', 'accepted', 'blocked')),
  requested_by  uuid not null references users(id) on delete cascade,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (user_a, user_b),
  check (user_a < user_b),
  check (requested_by = user_a or requested_by = user_b)
);

create index if not exists friendships_user_b_idx on friendships(user_b);

create table if not exists user_notes (
  owner_user_id   uuid not null references users(id) on delete cascade,
  target_user_id  uuid not null references users(id) on delete cascade,
  note            text not null check (length(note) <= 2000),
  updated_at      timestamptz not null default now(),
  primary key (owner_user_id, target_user_id)
);

-- Новые kind'ы уведомлений (заявка в друзья / заявка принята).
alter table user_notifications drop constraint if exists user_notifications_kind_check;
alter table user_notifications add constraint user_notifications_kind_check
  check (kind in ('mention', 'reply', 'call_incoming', 'friend_request', 'friend_accept'));
