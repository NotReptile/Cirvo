# Backend Modules

## `core-api`

`services/core-api` is a single deployable unit in the first iteration, but its internals are split into logical modules.

Модули лежат в `services/core-api/internal/modules/*`, каждый регистрирует свои маршруты в `RegisterRoutes(router)`. Состав и порядок регистрации - `internal/app/app.go` (`NewServer`). Сейчас там 20 модулей и 117 маршрутов плюс `/healthz`. Актуальный список маршрутов: `grep -rn "router\.\(Public\|Protected\)" services/core-api/internal/modules`.

| Модуль | Назначение |
| --- | --- |
| `auth` | Регистрация, login, refresh, logout/logout-all, `users/me`, список и отзыв сессий. Публичные ручки закрыты rate limit. |
| `profile` | Профиль: имя, статус, аватар, баннер, смена пароля, виджеты профиля, просмотр чужого профиля. |
| `workspace` | CRUD workspace, аватар, welcome-канал, участники (список, смена роли, удаление). |
| `role` | Кастомные роли workspace и их назначение. System-роли (`owner`, `admin`, `moderator`, `member`) защищены от удаления и смены `code`. `seed.go` - tx-хелперы для seed ролей при создании workspace и invite-accept. |
| `permission` | Резолвер прав, маршрутов нет. См. раздел ниже. |
| `channel` | Каналы (text, voice, forum), участники приватных каналов, override'ы прав по ролям и по пользователям, посты форума и треды на сообщениях. `access.go` - `channel.Resolve` (видимость канала и scope). |
| `category` | Категории каналов и override'ы прав на уровне категории. |
| `message` | Лента, создание/правка/удаление, реакции, закрепы, read state, непрочитанные, поиск. Ставит задачи `notification_jobs` и `link_preview_jobs`. |
| `attachment` | Загрузка файлов в object storage, выдача `media/{id}` и `media/{id}/thumb`; ставит задачу `thumbnail` в `media_jobs`. |
| `dm` | Личные сообщения: канал с `kind='dm'` и `workspace_id IS NULL`, одна пара пользователей - один DM. |
| `friend` | Друзья, заявки, блокировки, приватные заметки о пользователях. `friend.IsBlocked` используют `dm`, `call`, `message`. |
| `invite` | Приглашения: создание, список, отзыв, принятие; публичный preview по коду. |
| `notification` | Чтение in-app уведомлений, счётчик, mark-read, уровни уведомлений канала и workspace. `notification.Enqueue` - точка постановки задач для worker. |
| `call` | История 1-к-1 звонков (старт, завершение, чтение). Сам сигналинг идёт через `realtime`. |
| `voice` | Участники voice-каналов: `voice/join`, `voice/leave`, `voice/participants`; публикует `voice.joined` / `voice.left`. Лимит участников канала: 5 (mesh) или 50, если задан `CIRVO_SFU_URL`; при превышении `409`. |
| `ice` | Медиа-конфигурация клиента: `GET /api/v1/media/config` и алиас `GET /api/v1/ice-servers`. См. [realtime-and-calls.md](realtime-and-calls.md). |
| `wsticket` | Одноразовые WebSocket-тикеты (TTL 30 с, хранятся в Redis): `POST /api/v1/realtime/ticket` для `realtime` и `POST /api/v1/channels/{channelId}/voice/sfu-ticket` для SFU. |
| `audit` | Чтение и CSV-экспорт audit log workspace. Запись делает пакет `internal/auditlog` из других модулей. |
| `server` | Server-wide администрирование только для root-пользователя (`users.is_root`), остальным отвечает 404: настройки, список пользователей, ban/unban/delete, метрики, ручной запуск retention. |
| `system` | `GET /readyz`. |

Вне `modules/`: `internal/app` (сборка сервера, `Router.Public` / `Router.Protected`, bearer-аутентификация с проверкой `user_sessions`), `internal/bootstrap` (первый админ и workspace из `CIRVO_BOOTSTRAP_*`), `internal/serversettings` (кеш `server_settings`), `internal/auditlog`, `internal/authctx`, `internal/deps`, `internal/routing`.

## Dependency Rules

- transport handlers call application entrypoints only;
- domain modules do not read another module's tables directly without a contract;
- external systems are reached through infrastructure adapters;
- gateway concerns are treated as an edge role inside `core-api` in the first iteration.

Контрактами между модулями служат экспортируемые функции и интерфейсы: `channel.Resolve`, `permission.Authorize` / `AuthorizeChannel`, `friend.IsBlocked`, `notification.Enqueue`, интерфейс `PostSystemMessage`, который реализует `message` для `channel`, `call` и `invite`. Правило про чужие таблицы соблюдается не везде: например `voice`, `invite` и `call` читают `channels` или `workspace_members` напрямую. Это известное отклонение, см. код соответствующих `module.go`.

## Permission Module

`modules/permission` is the single resolver for "who can do what". Modules never compare role strings inline; they call `permission.Authorize(ctx, db, workspaceID, userID, action)` or `permission.AuthorizeChannel(...)` for channel-scoped checks.

- `Action` is a semantic constant (`permission.ChannelCreate`, `permission.MessageModerate`, ...). New permissions live here, not as new `if role == "..."` branches inside handlers. Полный список - `permission.AllActions`; те, что можно переопределять на канале - `permission.ChannelActions`.
- `Authorize` returns `(role, isMember, allowed)` so callers can distinguish 404 ("not a member - hide the workspace's existence") from 403 ("member but no permission").
- Права роли хранятся в БД: `workspace_roles.base_action_mask` (jsonb). Эффективный набор пользователя в workspace - объединение масок всех его ролей из `workspace_role_members`. Это покрывает и кастомные роли из модуля `role`.
- `AuthorizeChannel` накладывает слои: база ролей, затем `category_role_overrides`, затем `channel_role_overrides`, затем `channel_user_overrides` (высший приоритет). `owner` проходит без проверки слоёв. Для приватного канала право `channel.view` из базы игнорируется: нужен явный grant или запись в `channel_members`.
- Хардкод-матрица `baseHardcoded` осталась как fallback (если у пользователя нет ни одной роли в БД) и для `permission.Can(role, action)`. `Can` не знает кастомных ролей и не ходит в БД, в новом коде использовать `Authorize`. Seeded-матрица: `owner` - всё; `admin` - всё, кроме `workspace.delete`; `moderator` - модерация контента, каналы, инвайты, audit, kick; `member` - писать, реакции, вложения, упоминания, просмотр.
- To avoid an import cycle with `workspace` (which itself calls `permission.Authorize`), role codes are duplicated as unexported constants in `permission`. The canonical source remains `workspace.RoleOwner` / `RoleAdmin` / `RoleModerator` / `RoleMember`.

## `realtime`

`services/realtime` owns:

- websocket transport (`GET /ws`, одноразовый тикет или JWT);
- presence snapshots and updates;
- typing-индикатор (`typing.start`, без записи в БД);
- relay сигналинга звонков и voice-mesh (`call.*`, `voice.*`);
- durable-журнал событий `realtime_events` с replay после реконнекта.

Внутри: `internal/hub` (подключения, fan-out), `internal/eventjournal`, модули `transport`, `presence`, `signaling`, `typing`. События публикуют `core-api` и `worker` через `libs/shared-go/realtimebus`: запись в `realtime_events` и публикация в Redis, на который подписан `realtime`.

It does not own canonical message, workspace, membership or permission state.

## `sfu`

`services/sfu` - медиа-плоскость voice-каналов. Решение и обоснование: [ADR: SFU media path](../adr/adr-sfu-media-path.md).

- `internal/transport` - `GET /sfu/ws` (WebSocket-сигналинг) и `/healthz`. От клиента приходят `pub.offer`, `sub.answer`, `pub.ice`, `sub.ice`; сервер шлёт `pub.answer`, `sub.offer` и свои ICE-кандидаты.
- `internal/rtc` - `Engine` (общий `webrtc.API` и один UDP-сокет), `Manager` (комната = voice-канал), `Peer` (два PeerConnection: publisher и subscriber).
- Авторизация: тикет `purpose=sfu` либо JWT, плюс живая сессия в `user_sessions` и строка в `channel_participants`. Сервис только читает эти таблицы, пишет в них `core-api`.
- В `CIRVO_ENV=production` без `CIRVO_SFU_PUBLIC_IP` сервис не стартует.

## `worker`

`services/worker` не имеет HTTP-порта и крутит четыре независимых цикла (`cmd/worker/main.go`, код в `internal/jobs`).

| Цикл | Источник | Что делает |
| --- | --- | --- |
| `Runner` | `media_jobs` | Обрабатывает задачи по `kind`. Реализован `thumbnail`. |
| `NotificationRunner` | `notification_jobs` | Раскладывает записи в `user_notifications` и публикует `notification.created`. Виды: `mention`, `reply`, `call_incoming`, `mention_everyone` (получателей разворачивает worker), `friend_request`, `friend_accept`. |
| `LinkPreviewRunner` | `link_preview_jobs` | Берёт до 3 http(s)-ссылок из сообщения, читает OpenGraph (SSRF-guard, лимит 512 KiB, таймаут 8 с), пишет `messages.link_previews` и публикует `message.previews.updated`. |
| `RetentionRunner` | таймер | Раз в 24 часа (первый прогон через минуту после старта) вызывает `retention.Sweep` по `server_settings`: старые сообщения, orphan media, квота хранилища. Тот же код вручную запускает `POST /api/v1/server/retention/run`. |

Общая механика очередей:

- Polls with `update ... where id = (select ... for update skip locked limit 1) returning ...` so multiple replicas don't double-process.
- Retries with exponential backoff up to 3 attempts; terminal failures land in `status = 'failed'` with `last_error`.

### `media_jobs`

Handlers are registered in `jobs.Runner` keyed by `kind`. Adding a new media job type means:

1. add a job kind constant and handler implementing `jobs.Handler`;
2. register it in `NewRunner`;
3. schedule rows in `media_jobs` from the place that produces the work.

Если object storage недоступен при старте worker'а, handlers не регистрируются, и задачи `thumbnail` падают с `unknown kind`. Остальные циклы от этого не зависят; retention без store удаляет только строки БД.

Implemented kinds:

- `thumbnail` - fetches the source image from MinIO, resizes to 512 px on the longest side (`golang.org/x/image/draw` BiLinear), encodes as JPEG q80, writes `<key>.thumb.jpg` back to the bucket and updates `media_objects.thumbnail_object_key / thumbnail_width / thumbnail_height`. Triggered from `attachment.handleUpload` when the uploaded `content_type` matches `image/{jpeg,jpg,png,gif,webp}`.

Client consumes thumbnails via `GET /api/v1/media/{id}/thumb`. The endpoint falls back to the original object if the thumbnail has not been generated yet, so UI never breaks while a job is in flight.

`notification_jobs` и `link_preview_jobs` обслуживаются собственными runner'ами с той же схемой claim/retry, но без `jobs.Handler`. Audit fan-out в worker не реализован.
