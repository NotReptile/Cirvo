-- Wave 8: архив каналов + per-channel цвет имени.
-- archived_at: NULL = активный канал; not null = в архиве (soft, без удаления —
-- канал скрыт из основного списка, история и прямые ссылки продолжают работать).
-- name_color: hex-цвет имени канала в sidebar ('#rrggbb'), NULL = цвет темы.
alter table channels
  add column if not exists archived_at timestamptz,
  add column if not exists name_color text;

alter table channels
  add constraint channels_name_color_chk
    check (name_color is null or name_color ~ '^#[0-9a-fA-F]{6}$');
