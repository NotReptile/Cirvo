update workspace_roles
set base_action_mask = array(
  select x from unnest(base_action_mask) as x where x <> 'workspace.delete'
)
where 'workspace.delete' = any(base_action_mask);
