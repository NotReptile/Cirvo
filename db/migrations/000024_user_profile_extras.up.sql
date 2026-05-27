-- I.6 — расширенные поля профиля юзера (Discord-style profile card).
--
-- bio                 — короткий «о себе», markdown (рендерит фронт),
--                       лимит 600 символов на бэке. Не индексируем
--                       (не предполагаем поиск по био).
-- pronouns            — местоимения «он/она/они», свободный текст до 32.
--                       Отдельно от displayName — может пустовать.
-- banner_color        — hex-цвет баннера профиль-карточки. Применяется
--                       когда banner_media_id == NULL (либо у юзера
--                       нет загруженной картинки).
-- banner_media_id     — загруженный баннер (image). FK → media_objects,
--                       on delete set null (удаление медиа = откат на
--                       banner_color без 500-ки).
--
-- Все поля nullable / default '' — никаких backfill'ов не требуется,
-- старые клиенты увидят пустые значения и отрисуют дефолтную карточку.

alter table users
  add column if not exists bio text,
  add column if not exists pronouns text,
  add column if not exists banner_color text,
  add column if not exists banner_media_id uuid
    references media_objects(id) on delete set null;

-- Лёгкий guard: bio ≤ 600, pronouns ≤ 32, banner_color короткий hex.
-- Реальная валидация — на бэке (profile-handler), а check'и тут — sanity.
alter table users
  add constraint users_bio_len_chk
    check (bio is null or length(bio) <= 600),
  add constraint users_pronouns_len_chk
    check (pronouns is null or length(pronouns) <= 32),
  add constraint users_banner_color_len_chk
    check (banner_color is null or length(banner_color) <= 16);

create index if not exists users_banner_media_idx
  on users (banner_media_id)
  where banner_media_id is not null;
