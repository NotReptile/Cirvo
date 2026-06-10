update workspace_roles
set base_action_mask = array(
  select x from unnest(base_action_mask) as x where x <> 'message.mention_everyone'
)
where 'message.mention_everyone' = any(base_action_mask);

alter table messages drop column if exists mention_everyone;
