-- При откате сохраняем уведомление и payload. Старый контракт допускает
-- обычное упоминание; mentionKind в payload остаётся для контекста.
update user_notifications set kind = 'mention' where kind = 'mention_everyone';
alter table user_notifications drop constraint if exists user_notifications_kind_check;
alter table user_notifications add constraint user_notifications_kind_check
  check (kind in ('mention', 'reply', 'call_incoming', 'friend_request', 'friend_accept'));
