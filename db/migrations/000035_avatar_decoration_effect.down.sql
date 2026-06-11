alter table users
  drop constraint if exists users_avatar_decoration_len_chk,
  drop constraint if exists users_profile_effect_len_chk;

alter table users
  drop column if exists avatar_decoration,
  drop column if exists profile_effect;
