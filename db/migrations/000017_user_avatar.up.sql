-- H.1 — аватары пользователей.
--
-- users.avatar_media_id ссылается на media_objects. ON DELETE SET NULL —
-- если media удалена (retention sweep / админ), юзер просто откатится
-- на placeholder с буквой. Колонка nullable: новый юзер без аватара.
--
-- Доступ к media-аватара ослаблен в attachment.canAccess (см. backend):
-- авторизованные юзеры в shared workspaces могут читать аватары друг
-- друга, не требуется attachment в общем канале.

alter table users add column if not exists avatar_media_id uuid references media_objects(id) on delete set null;

create index if not exists users_avatar_media_idx on users (avatar_media_id) where avatar_media_id is not null;
