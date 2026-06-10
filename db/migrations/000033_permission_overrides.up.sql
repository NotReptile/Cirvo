-- Wave 5: per-user и per-category permission overrides.
--
-- channel_user_overrides — точечные права конкретного юзера в конкретном
-- канале. Высший приоритет в резолвере: deny юзера бьёт любые grant'ы
-- ролей, grant юзера бьёт любые deny ролей (Discord-семантика "member
-- overwrite"). Owner по-прежнему короткозамыкается до allowed=true.
--
-- category_role_overrides — override'ы ролей на уровне категории,
-- наследуются всеми каналами категории. Слой между base_action_mask и
-- channel_role_overrides: канальный override перекрывает категорийный.
--
-- Итоговый порядок резолва в AuthorizeChannel:
--   base(union ролей) → category role → channel role → channel user.

create table if not exists channel_user_overrides (
    channel_id         uuid not null references channels(id) on delete cascade,
    user_id            uuid not null references users(id) on delete cascade,
    granted_actions    text[] not null default '{}',
    denied_actions     text[] not null default '{}',
    updated_at         timestamptz not null default now(),
    updated_by_user_id uuid references users(id) on delete set null,
    primary key (channel_id, user_id)
);

create table if not exists category_role_overrides (
    category_id        uuid not null references channel_categories(id) on delete cascade,
    role_id            uuid not null references workspace_roles(id) on delete cascade,
    granted_actions    text[] not null default '{}',
    denied_actions     text[] not null default '{}',
    updated_at         timestamptz not null default now(),
    updated_by_user_id uuid references users(id) on delete set null,
    primary key (category_id, role_id)
);

create index if not exists category_role_overrides_role_idx
    on category_role_overrides (role_id);
