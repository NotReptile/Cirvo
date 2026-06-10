-- Wave 4: серверный @everyone/@here.
--
-- messages.mention_everyone — какой массовый пинг реально сработал в этом
-- сообщении ('everyone' | 'here' | NULL). Заполняется бэком только если у
-- автора есть право message.mention_everyone; клиент по этому полю решает,
-- подсвечивать ли токен (без права — обычный текст, как в Discord).
--
-- Новый permission.Action 'message.mention_everyone' — отдельный от
-- 'message.mention', потому что массовый пинг шумный и по умолчанию его
-- получают только owner/admin/moderator. Backfill в base_action_mask
-- существующих ролей; для новых воркспейсов набор зашит в role/seed.go.

alter table messages
  add column mention_everyone text
  check (mention_everyone in ('everyone', 'here'));

update workspace_roles
set base_action_mask = array(
  select distinct unnest(base_action_mask || array['message.mention_everyone'])
)
where code in ('owner', 'admin', 'moderator')
  and not ('message.mention_everyone' = any(base_action_mask));
