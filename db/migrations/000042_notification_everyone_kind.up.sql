-- Массовые упоминания имеют отдельный клиентский тип: настройка muteEveryone
-- и подпись @everyone/@here зависят от него. 000032 добавила producer, но
-- CHECK уведомлений остался на наборе 000030 и отклонял доставку worker.
alter table user_notifications drop constraint if exists user_notifications_kind_check;
alter table user_notifications add constraint user_notifications_kind_check
  check (kind in ('mention', 'reply', 'call_incoming', 'friend_request', 'friend_accept', 'mention_everyone'));
