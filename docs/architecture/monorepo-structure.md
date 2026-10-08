# Monorepo Structure

## Root Layout

- `apps` - user-facing applications.
- `services` - deployable backend processes.
- `db` - relational model artifacts.
- `libs` - shared code and contracts.
- `deploy` - environment-specific deployment assets.
- `docs` - technical wiki and ADRs.

## Responsibility Map

| Путь | Что там |
| --- | --- |
| `apps/desktop` | Клиент на TypeScript + Vite. `src/app` - UI и bootstrap, `src/network` - HTTP, `src/realtime` - WebSocket, `src/call` - WebRTC (звонки, voice-каналы, SFU-сессия, шумоподавление, эффекты камеры). |
| `apps/desktop/src-tauri` | Rust-оболочка Tauri 2: захват экрана и системного звука, глобальные хоткеи, updater. Команды описаны в `src/lib.rs`. |
| `services/core-api` | HTTP API, порт `8080`. Доменные модули в `internal/modules/*`, вспомогательные пакеты `internal/{app,auditlog,authctx,bootstrap,deps,routing,serversettings}`. `smoketests/` - smoke-тесты на живой инфраструктуре (build tag `smoke`). |
| `services/realtime` | WebSocket-узел, порт `8090`. `internal/{hub,eventjournal}` и модули `transport`, `presence`, `signaling`, `typing`. |
| `services/sfu` | SFU на pion, порт `8095` + UDP-порт медиа. `internal/transport` - WS-сигналинг `/sfu/ws`, `internal/rtc` - engine, комнаты и peer'ы. |
| `services/worker` | Фоновые циклы, `internal/jobs`: thumbnail, notifications, link preview, retention. |
| `db/migrations` | Нумерованные миграции golang-migrate. `db/schema/README.md` - описание области схемы. |
| `libs/contracts` | Контракты: `http/openapi.yaml` (неполный, см. [API overview](../api/overview.md)), `realtime/events.json` (`RealtimeEnvelopeV2`), `errors/error-model.json`. |
| `libs/shared-go` | Общий Go-код: `config`, `httpx`, `jwtauth`, `objectstore`, `observability`, `passwords`, `postgres`, `ratelimit`, `realtimebus`, `redisstore`, `retention`, `wsticket`. |
| `libs/shared-ts` | Общие TypeScript-типы (`@rucord/shared-ts`). |
| `deploy/local` | compose для разработки: Postgres, Redis, MinIO; профили `tools` (migrate), `turn` (coturn), `public-ip` (HTTP-прокси). Go-сервисы запускаются на хосте. |
| `deploy/single-node` | Актуальный production-профиль: весь стек в одном compose, включая `sfu` и `coturn`. |
| `deploy/Dockerfile.service` | Один Dockerfile для `core-api`, `realtime`, `sfu`, `worker` (build-arg `SERVICE_NAME`, контекст - корень репозитория). |
| `deploy/backup.sh`, `deploy/restore.sh` | Бэкап и восстановление Postgres и MinIO. |
| `docs` | Wiki, ADR, runbooks. |

Корневые файлы: `go.work` объединяет `libs/shared-go` и четыре сервиса; `package.json` задаёт npm workspaces (`apps/*`, `libs/shared-ts`); `.github/workflows` - `smoke.yml` и `desktop-release.yml`.

## Why Monorepo

- contracts, docs and code evolve together;
- environment and deployment assets stay versioned with services;
- changes across desktop, backend and migrations can be reviewed in one place;
- the first iteration remains simple without cross-repository coordination overhead.
