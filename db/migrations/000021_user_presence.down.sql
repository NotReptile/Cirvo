alter table users
  drop column if exists custom_status,
  drop column if exists presence_mode;
