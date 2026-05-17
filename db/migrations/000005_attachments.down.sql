alter table upload_sessions drop column if exists completed_at;
alter table upload_sessions drop column if exists status;
alter table upload_sessions drop column if exists media_id;

drop index if exists message_attachments_message_idx;
drop index if exists message_attachments_media_idx;
drop table if exists message_attachments;

drop index if exists media_objects_uploader_idx;
drop table if exists media_objects;
