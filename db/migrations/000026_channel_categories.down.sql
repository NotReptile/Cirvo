alter table channels drop column if exists category_id;
drop index if exists channels_category_idx;
drop index if exists channel_categories_workspace_idx;
drop table if exists channel_categories;
