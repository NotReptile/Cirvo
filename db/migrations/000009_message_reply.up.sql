-- Reply на сообщение. set null при удалении цитируемого — лучше чем
-- cascade: если на цитату ссылались, потеря исходника не должна сносить
-- ответы. В UI замена «сообщение удалено».
alter table messages
  add column if not exists reply_to_message_id uuid references messages(id) on delete set null;

create index if not exists messages_reply_to_idx on messages(reply_to_message_id);
