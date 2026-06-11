-- Wave 7 (I.15–I.16): рамка аватара и эффект профиля.
--
-- avatar_decoration — id CSS-пресета рамки/свечения вокруг аватара
-- (gold/neon/rainbow/frost/ember). Рендерится поверх любого аватара
-- (и картинки, и буквы-заглушки) во всех местах через renderAvatar.
--
-- profile_effect — id CSS-пресета анимированного оверлея на баннере
-- карточки профиля (sparkles/pulse/rain/aurora).
--
-- Пресеты — чистый CSS на клиенте, без файлов-ассетов (тот же подход,
-- что у синтезированных звуков уведомлений). Неизвестный id клиент
-- молча игнорирует — это позволит менять набор пресетов без миграций.

alter table users
  add column if not exists avatar_decoration text,
  add column if not exists profile_effect text;

alter table users
  add constraint users_avatar_decoration_len_chk
    check (avatar_decoration is null or length(avatar_decoration) <= 32),
  add constraint users_profile_effect_len_chk
    check (profile_effect is null or length(profile_effect) <= 32);
