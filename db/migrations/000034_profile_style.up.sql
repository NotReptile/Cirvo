-- Wave 7 (I.17–I.19): стиль профиля — тема карточки, градиент имени, бейдж.
--
-- profile_theme / name_gradient — пара hex-цветов "#rrggbb,#rrggbb"
-- (градиент сверху-вниз для карточки, слева-направо для имени). Плоский
-- text вместо jsonb из плана: формат фиксированный (ровно два цвета),
-- парсер на клиенте — split(','), валидация regexp'ом на бэке. Самый
-- дешёвый вариант без json-маршалинга.
--
-- badge_emoji / badge_label — инлайн-бейдж после имени (emoji + tooltip).
-- Бесплатная Nitro-параллель: self-host, никаких подписок.

alter table users
  add column if not exists profile_theme text,
  add column if not exists name_gradient text,
  add column if not exists badge_emoji text,
  add column if not exists badge_label text;

alter table users
  add constraint users_profile_theme_len_chk
    check (profile_theme is null or length(profile_theme) <= 32),
  add constraint users_name_gradient_len_chk
    check (name_gradient is null or length(name_gradient) <= 32),
  add constraint users_badge_emoji_len_chk
    check (badge_emoji is null or length(badge_emoji) <= 32),
  add constraint users_badge_label_len_chk
    check (badge_label is null or length(badge_label) <= 48);
