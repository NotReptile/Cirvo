-- I.6 — откат расширенных полей профиля.
alter table users
  drop constraint if exists users_bio_len_chk,
  drop constraint if exists users_pronouns_len_chk,
  drop constraint if exists users_banner_color_len_chk;

drop index if exists users_banner_media_idx;

alter table users
  drop column if exists bio,
  drop column if exists pronouns,
  drop column if exists banner_color,
  drop column if exists banner_media_id;
