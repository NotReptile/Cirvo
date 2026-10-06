# API Overview

## Source Of Truth

Источник истины по HTTP API - код, а не спецификация.

`libs/contracts/http/openapi.yaml` неполная и устарела. Она описывает 4 пути (`/healthz`, `/api/v1/auth/register`, `/api/v1/workspaces`, `/api/v1/channels/{channelId}/messages`) при 117 маршрутах модулей `core-api` плюс `/healthz`. Описания в ней местами не совпадают с кодом: например `POST /api/v1/auth/register` в спецификации отвечает `202` как заглушка, а `handleRegister` возвращает `201` и `authResponse` (`user`, `accessToken`, `accessExpiresAt`, `refreshToken`, `sessionId`). Автогенерации и проверки спецификации против кода в репозитории нет. Пока спека не доведена до полной, не опирайся на неё при разработке клиента.

Где смотреть актуальное:

- маршруты: `router.Public(...)` и `router.Protected(...)` в `services/core-api/internal/modules/*/module.go`, список командой `grep -rn "router\.\(Public\|Protected\)" services/core-api/internal/modules`;
- форматы запросов и ответов: структуры и хендлеры рядом с регистрацией маршрутов;
- ошибки: `libs/contracts/errors/error-model.json` (оно соответствует коду) и `libs/shared-go/httpx/errors.go`;
- realtime-события: `libs/contracts/realtime/events.json` (`RealtimeEnvelopeV2`) и [realtime-and-calls.md](../architecture/realtime-and-calls.md).

## Conventions

- Префикс `/api/v1`, JSON.
- Публичные маршруты (`router.Public`): `POST /auth/register`, `/auth/login`, `/auth/refresh`, `GET /invites/{code}` (preview приглашения), а также `GET /healthz` и `GET /readyz`. Все остальные - `router.Protected`.
- Аутентификация: `Authorization: Bearer <access JWT>`. Middleware проверяет JWT и то, что сессия в `user_sessions` не отозвана (иначе `401`, код `session_revoked`). TTL access-токена задаёт `RUCORD_JWT_ACCESS_TTL` (в compose по умолчанию `15m`), новый токен выдаёт `POST /auth/refresh`.
- Формат ошибки: `{"error": {"code", "message", "requestId"}}`. Коды: `validation_failed`, `authentication_failed`, `authorization_denied`, `resource_not_found_or_not_visible`, `conflict`, `rate_limited`, `session_revoked`, `internal_error`, `message_already_processed`. Ресурс, который пользователь не должен видеть, как правило отдаётся как `404`, а не `403` (код `resource_not_found_or_not_visible`).
- Rate limit (Redis): register 5 в час, login 10 за 5 минут, refresh 30 за 5 минут, принятие инвайта 20 в час, загрузки 60 запросов за 10 минут и 500 MiB в час на пользователя (см. код: константы `*Rule` в модулях `auth`, `invite`, `attachment`). Ответ `429` содержит `Retry-After`.

## Route Groups (core-api)

| Область | Модуль | Примеры маршрутов |
| --- | --- | --- |
| Health | `system`, `app` | `GET /healthz`, `GET /readyz` |
| Auth и сессии | `auth` | `POST /auth/register\|login\|refresh\|logout\|logout-all`, `GET /users/me`, `GET /users/me/sessions`, `DELETE /users/me/sessions/{sessionId}` |
| Профиль | `profile` | `PUT /users/me`, `/users/me/password\|status\|avatar\|banner\|widgets`, `GET /users/{userId}`, `GET /users/{userId}/widgets` |
| Workspace | `workspace` | `GET\|POST /workspaces`, `GET\|PATCH\|DELETE /workspaces/{id}`, `/avatar`, `/welcome-channel`, `/members` |
| Роли | `role` | `/workspaces/{id}/roles`, назначение через `/roles/{roleId}/members/{userId}` |
| Приглашения | `invite` | `/workspaces/{id}/invites`, `DELETE /invites/{inviteId}`, `GET /invites/{code}`, `POST /invites/{code}/accept` |
| Каналы | `channel`, `category` | `/workspaces/{id}/channels`, `/channels/{id}` (+ `/members`, `/permissions`, `/user-permissions`, `/forum/posts`, `/messages/{messageId}/thread`), `/workspaces/{id}/categories`, `/categories/{id}` (+ `/permissions`) |
| Сообщения | `message` | `GET\|POST /channels/{id}/messages`, `PATCH\|DELETE /messages/{id}`, реакции, закрепы, `/channels/{id}/read`, `/workspaces/{id}/unread`, `/workspaces/{id}/search` |
| Вложения и медиа | `attachment` | `POST /uploads`, `GET /media/{mediaId}`, `GET /media/{mediaId}/thumb` |
| Личные сообщения | `dm` | `GET\|POST /dm`, `GET /dm/unread` |
| Друзья | `friend` | `/friends`, `/friends/requests`, `/friends/{userId}/accept\|block`, `/users/{userId}/note` |
| Уведомления | `notification` | `/notifications`, `/notifications/count`, `/notifications/read`, `/users/me/notification-prefs`, `/channels/{id}/notification-pref`, `/workspaces/{id}/notification-pref` |
| Звонки | `call` | `POST /calls`, `POST /calls/{callId}/end`, `GET /calls/{callId}`, `GET /channels/{id}/calls` |
| Voice-каналы | `voice` | `POST /channels/{id}/voice/join\|leave`, `GET /channels/{id}/voice/participants` |
| Realtime и медиа | `wsticket`, `ice` | `POST /realtime/ticket`, `POST /channels/{id}/voice/sfu-ticket`, `GET /media/config`, `GET /ice-servers` (алиас) |
| Audit | `audit` | `GET /workspaces/{id}/audit`, `GET /workspaces/{id}/audit/export` |
| Server admin (root) | `server` | `/server/settings`, `/server/users`, `/server/users/{userId}/ban\|unban`, `/server/metrics`, `POST /server/retention/run` |

Пути в таблице даны без префикса `/api/v1` (кроме `/healthz` и `/readyz`).

## Other Endpoints

Эти эндпоинты не входят в `core-api`:

- `realtime` (порт `8090`): `GET /ws` - WebSocket, параметры `ticket` (одноразовый, из `POST /api/v1/realtime/ticket`) либо legacy `access_token`, и `cursor` для replay; `GET /healthz`; служебные `GET /api/v1/signaling/health`, `GET /api/v1/presence/stats`.
- `sfu` (порт `8095`): `GET /sfu/ws` - WebSocket-сигналинг SFU, параметр `ticket` (из `POST /api/v1/channels/{id}/voice/sfu-ticket`) либо legacy `access_token` + `channel_id`; `GET /healthz`.

В single-node Caddy направляет `/ws*` в `realtime`, `/sfu/ws*` в `sfu`, а `/api/*`, `/healthz`, `/readyz` в `core-api`. Поэтому служебные `/api/v1/signaling/health` и `/api/v1/presence/stats` через прокси недоступны. См. `deploy/single-node/Caddyfile`.
