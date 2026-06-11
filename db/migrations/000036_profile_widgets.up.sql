-- Wave 7 (I.13): виджеты профиля — блоки под bio в карточке профиля.
--
-- Пока один kind='link' (ссылки на GitHub/Twitch/Steam/что угодно);
-- payload jsonb {label, url} — расширение под будущие kind'ы
-- (pinned-message и т.п.) без миграций. position — порядок в карточке,
-- клиент сохраняет полной заменой списка (PUT), позиции = индексы.
-- Лимит ≤8 виджетов на юзера проверяет бэк.

create table if not exists user_profile_widgets (
    id         uuid primary key,
    user_id    uuid not null references users(id) on delete cascade,
    position   int  not null default 0,
    kind       text not null check (kind in ('link')),
    payload    jsonb not null default '{}',
    created_at timestamptz not null default now()
);

create index if not exists user_profile_widgets_user_idx
    on user_profile_widgets (user_id, position);
