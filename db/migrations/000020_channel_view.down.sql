update workspace_roles
set base_action_mask = array(
  select x from unnest(base_action_mask) as x where x <> 'channel.view'
)
where 'channel.view' = any(base_action_mask);
