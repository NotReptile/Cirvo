alter table user_notifications drop constraint if exists user_notifications_kind_check;
alter table user_notifications add constraint user_notifications_kind_check
  check (kind in ('mention', 'reply', 'call_incoming'));
drop table if exists user_notes;
drop table if exists friendships;
