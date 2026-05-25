-- H.10 Workspace-settings модалка.
--
-- Новый permission.Action 'workspace.delete' — отдельная от
-- 'workspace.update', потому что в Discord-like-UX удаление сервера
-- может только owner. Backfill: добавляем 'workspace.delete' в
-- base_action_mask только owner-роли всех существующих воркспейсов;
-- admin/moderator/member не получают.
--
-- Для новых воркспейсов default-набор зашит в role/seed.go (Actions
-- для CodeOwner).

update workspace_roles
set base_action_mask = array(
  select distinct unnest(base_action_mask || array['workspace.delete'])
)
where code = 'owner'
  and not ('workspace.delete' = any(base_action_mask));
