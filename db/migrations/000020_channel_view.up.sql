-- H.6 Приватные каналы по ролям.
--
-- Добавляем action 'channel.view' в base_action_mask всех системных
-- workspace_roles. Для PUBLIC-каналов наличие 'channel.view' в base — это
-- разрешение видеть канал (по умолчанию у всех seeded ролей). Для
-- PRIVATE-каналов AuthorizeChannel специально игнорирует base_action_mask
-- для view-action'а: доступ к приватному каналу даётся ТОЛЬКО через
-- channel_role_overrides.granted_actions либо членство в channel_members.
--
-- Owner короткозамыкается в AuthorizeChannel и видит всё всегда.

update workspace_roles
set base_action_mask = array(
  select distinct unnest(base_action_mask || array['channel.view'])
)
where not ('channel.view' = any(base_action_mask));
