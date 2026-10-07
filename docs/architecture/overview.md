# Architecture Overview

## Goal

RuCord is a modular communication platform with a Tauri desktop client and a Go backend. The first iteration optimizes for clear boundaries, portability and a viable MVP instead of early microservice expansion.

## Runtime Units

- `apps/desktop` - desktop client shell on Tauri and TypeScript.
- `services/core-api` - main API process with internal domain modules (HTTP, порт `8080`, `/healthz` и `/readyz`).
- `services/realtime` - WebSocket-транспорт `/ws`, presence, typing и relay сигналинга `call.*` / `voice.*` (порт `8090`).
- `services/sfu` - SFU на pion/webrtc v4 для voice-каналов: WebSocket-сигналинг `/sfu/ws` (порт `8095`) и один UDP-порт для RTP (`RUCORD_SFU_UDP_PORT`: в compose по умолчанию `50000`, в коде `8443`). См. [ADR: SFU media path](../adr/adr-sfu-media-path.md).
- `services/worker` - фоновые циклы без HTTP-порта: превью изображений (`media_jobs`), уведомления (`notification_jobs`), link preview (`link_preview_jobs`) и суточный retention-sweep. Подробности в [backend-modules.md](backend-modules.md).
- `coturn` - сторонний TURN/STUN-сервер, не Go-сервис; описан в `deploy/single-node/docker-compose.yml` (порты `3478` tcp/udp и relay `49160-49200/udp`). Доступ клиентов выдаёт `core-api` через `GET /api/v1/media/config`.
- `db` - relational schema and migrations. The first admin user and default workspace are not seeded as SQL; `core-api` provisions them from `RUCORD_BOOTSTRAP_*` env on the first startup against an empty DB.

Общая инфраструктура: Postgres 16, Redis 7, MinIO (S3), Caddy как reverse-proxy в single-node. Go-сервисы живут в одном `go.work`, каждый со своим `go.mod`; общий код - в `libs/shared-go`.

## Boundary Rules

- `core-api` is the source of truth for core domain state.
- `realtime` доставляет события и presence. Durable-журнал `realtime_events` лежит в Postgres (окно replay 7 дней) и нужен только чтобы закрыть разрыв при реконнекте; канонических данных домена он не хранит.
- Redis хранит только транзитное: pub/sub между `core-api`/`worker` и `realtime`, одноразовые WS-тикеты, счётчики rate limit. Отдельного брокера в коде нет.
- object storage is reserved for file and media payloads.
- Сигналинг, оркестрация сессий и медиа-плоскость разделены. `core-api` владеет метаданными и политикой (членство в voice-канале, лимиты участников, ICE-конфигурация), но не трогает медиа-поток; RTP идёт через SFU (или mesh между клиентами), relay для NAT - через coturn.
- SFU не принимает решений об ACL: он доверяет строке в `channel_participants`, которую пишет `core-api` в `POST /voice/join`, и дополнительно проверяет живую сессию в `user_sessions`.

## Media Paths

- 1-к-1 звонок: прямое P2P WebRTC-соединение, сигналинг через `realtime`, TURN как fallback.
- Voice-канал: режим выбирает конфигурация деплоя. Если задан `RUCORD_SFU_URL`, `core-api` отдаёт `mode: "sfu"` и клиент ходит через `services/sfu` (лимит канала 50). Иначе `mode: "mesh"` (лимит 5, клиенты соединяются друг с другом).
- `local`: SFU и coturn в compose не входят, по умолчанию mesh. `single-node`: SFU и coturn поднимаются всегда, SFU - основной production-транспорт.

Подробнее: [realtime-and-calls.md](realtime-and-calls.md).
