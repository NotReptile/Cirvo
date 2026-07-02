-- Wave 10: треды на сообщениях. Тред = дочерний канал kind='thread'
-- (та же модель, что посты форума, миграция 38), но с якорем на корневое
-- сообщение text-канала. По root_message_id клиент рисует чип «N ответов»
-- под сообщением, а сервер отдаёт агрегаты треда в message list.
alter table channels add column if not exists root_message_id uuid references messages(id) on delete set null;

-- Один тред на сообщение: гонка двух параллельных «Создать тред» решается
-- on conflict do nothing + повторным select существующего.
create unique index if not exists channels_root_message_uidx on channels(root_message_id) where root_message_id is not null;
