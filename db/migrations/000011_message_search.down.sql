drop index if exists messages_search_gin_idx;
alter table messages drop column if exists search_vector;
