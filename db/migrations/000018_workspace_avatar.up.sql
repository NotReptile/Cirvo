-- H.2 — иконка воркспейса.
--
-- workspaces.avatar_media_id ссылается на media_objects. ON DELETE SET NULL —
-- если media удалена (retention sweep / админ), воркспейс откатится на
-- placeholder с буквой (как у юзеров без аватара).
--
-- Доступ к media-иконке ослаблен в attachment.canAccess (см. backend):
-- любой авторизованный юзер может скачать иконку воркспейса (в self-host
-- сценарии аудитория ограничена, иконка by-design публичная — её видят
-- все, кто получит инвайт-код).

alter table workspaces add column if not exists avatar_media_id uuid references media_objects(id) on delete set null;

create index if not exists workspaces_avatar_media_idx on workspaces (avatar_media_id) where avatar_media_id is not null;
