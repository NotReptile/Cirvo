-- J.5: пользовательские категории каналов. Раньше категории были
-- хардкод-блоками «Текстовые» / «Голосовые». Теперь — CRUD-сущности
-- с position'ом, owner/admin рулят составом.
--
-- channels.category_id может быть NULL — это «Без категории» (Discord-like),
-- рендерится отдельным блоком сверху или снизу списка. on delete set null
-- даёт мягкое удаление категории: каналы остаются, просто становятся
-- беспривязочными.

create table if not exists channel_categories (
    id           uuid primary key,
    workspace_id uuid not null references workspaces(id) on delete cascade,
    name         text not null,
    position     int  not null default 0,
    created_at   timestamptz not null default now(),
    constraint channel_categories_name_len_chk check (length(name) between 1 and 64)
);

create index if not exists channel_categories_workspace_idx
    on channel_categories (workspace_id, position, created_at);

alter table channels
    add column if not exists category_id uuid
        references channel_categories(id) on delete set null;

create index if not exists channels_category_idx
    on channels (category_id) where category_id is not null;

-- Backfill: для каждого ws создаём две дефолтных категории «Текстовые»/
-- «Голосовые» и привязываем существующие каналы по kind. Это сохраняет
-- старый UX — после миграции структура выглядит как раньше.
do $$
declare
    ws record;
    text_cat_id uuid;
    voice_cat_id uuid;
begin
    for ws in select id from workspaces loop
        text_cat_id := gen_random_uuid();
        voice_cat_id := gen_random_uuid();
        insert into channel_categories (id, workspace_id, name, position)
            values (text_cat_id, ws.id, 'Текстовые каналы', 0);
        insert into channel_categories (id, workspace_id, name, position)
            values (voice_cat_id, ws.id, 'Голосовые каналы', 1);
        update channels set category_id = text_cat_id
            where workspace_id = ws.id and kind = 'text' and category_id is null;
        update channels set category_id = voice_cat_id
            where workspace_id = ws.id and kind = 'voice' and category_id is null;
    end loop;
end $$;
