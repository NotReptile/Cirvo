-- Pinned messages. Discord-pattern: булевый флаг на сообщении + кто/когда
-- закрепил. Лимит (50 на канал) проверяется в приложении, в БД hard cap
-- не ставим — миграцию проще, и админам иногда нужно временно превысить.
alter table messages
  add column if not exists is_pinned boolean not null default false,
  add column if not exists pinned_at timestamptz,
  add column if not exists pinned_by uuid references users(id) on delete set null;

-- Partial index: GET /channels/{id}/pins выбирает только is_pinned=true,
-- partial index в разы компактнее full на messages.channel_id.
create index if not exists messages_pinned_idx
  on messages (channel_id, pinned_at desc)
  where is_pinned = true and deleted_at is null;
