-- Mentions @username в сообщении. Парсим body на стороне core-api при
-- create/edit, резолвим slug → user_id в рамках workspace канала,
-- сохраняем здесь. Cascade на оба FK: при удалении сообщения/юзера
-- запись бессмысленна.
create table if not exists message_mentions (
  message_id uuid not null references messages(id) on delete cascade,
  user_id    uuid not null references users(id)    on delete cascade,
  primary key (message_id, user_id)
);

-- индекс «упоминания юзера X» — для будущей C.8 (notifications) и
-- возможной выдачи «упоминания меня в воркспейсе».
create index if not exists message_mentions_user_idx on message_mentions(user_id);
