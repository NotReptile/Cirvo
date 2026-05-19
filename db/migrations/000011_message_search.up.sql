-- Полнотекстовый поиск по messages.body.
-- Generated column tsvector + GIN индекс. Конфиг `russian` — стеммит
-- русские формы (сообщение/сообщения/сообщению), пропускает прочие
-- токены as-is (латиница, цифры, эмодзи), что для смешанного RU/EN
-- контента даёт приемлемый MVP без локальной разметки language column.
-- coalesce: body уже NOT NULL по схеме, но perfect-defence на случай
-- будущих ALTER'ов.
alter table messages
  add column search_vector tsvector
  generated always as (to_tsvector('russian', coalesce(body, ''))) stored;

create index messages_search_gin_idx on messages using gin(search_vector);
