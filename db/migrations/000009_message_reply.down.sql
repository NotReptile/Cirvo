drop index if exists messages_reply_to_idx;
alter table messages drop column if exists reply_to_message_id;
