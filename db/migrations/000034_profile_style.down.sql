alter table users
  drop constraint if exists users_profile_theme_len_chk,
  drop constraint if exists users_name_gradient_len_chk,
  drop constraint if exists users_badge_emoji_len_chk,
  drop constraint if exists users_badge_label_len_chk;

alter table users
  drop column if exists profile_theme,
  drop column if exists name_gradient,
  drop column if exists badge_emoji,
  drop column if exists badge_label;
