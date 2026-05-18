alter table media_objects drop column if exists thumbnail_height;
alter table media_objects drop column if exists thumbnail_width;
alter table media_objects drop column if exists thumbnail_object_key;

drop index if exists media_jobs_media_idx;
drop index if exists media_jobs_pending_idx;
drop table if exists media_jobs;
