# RuCord

Self-host чат и голос для дружеских кружков и небольших/средних сообществ
(десятки—сотни пользователей на инстанс). Скачал, запустил у себя — получил
«свой Discord» с текстовыми и голосовыми каналами, screen-share, ролями и
приглашениями. Один инстанс = один сервер; внутри допустимы несколько
workspace'ов.

Клиенты — десктоп (Tauri, Windows — основная платформа), web (PWA, planned)
и Android (Tauri mobile, planned) из одной TypeScript-кодовой базы.

> **Статус: ранняя версия (0.1.x).** Сервер работает в боевом режиме, клиент для
> Windows собирается и тестируется.

## Быстрые ссылки

- Поставить клиент на Windows: [docs/runbooks/windows-client.md](docs/runbooks/windows-client.md)
- Поднять свой сервер: [Single-node](#single-node-продакшн-на-одной-машине)
- Выпустить новую версию клиента: [docs/runbooks/desktop-release.md](docs/runbooks/desktop-release.md)
- Что-то не работает: [docs/runbooks/diagnostics.md](docs/runbooks/diagnostics.md)
- Работа с репозиторием через ИИ-агентов: [AGENTS.md](AGENTS.md)

## Что внутри

| Каталог | Что это |
| --- | --- |
| `apps/desktop` | Tauri-клиент на TypeScript |
| `services/core-api` | Go HTTP API (порт 8080) |
| `services/realtime` | Go WebSocket-узел, presence, WebRTC signaling (порт 8090) |
| `services/sfu` | Go SFU для группового голоса и видео (порт 8095, медиа по UDP 50000) |
| `services/worker` | Go background jobs (thumbnails, retention…) |
| `db/migrations` | golang-migrate миграции |
| `deploy/` | compose-файлы: `local` (разработка) и `single-node` (продакшн); `internet-facing` — устаревший черновик |
| `docs/` | wiki, ADR, runbooks |

Кроме Go-сервисов стек включает Postgres, Redis, MinIO, coturn (TURN, порт 3478)
и Caddy (TLS и reverse-proxy).

## Требования

- Docker (с `docker compose`): единственное требование для запуска сервера
- Go 1.26+ — только для разработки
- Node.js 20.19+ или 22.12+ — для сборки десктоп-клиента
- Rust stable и MSVC Build Tools — только для локальной сборки exe

## Что обязательно поменять перед первым запуском

`cp deploy/.env.example deploy/.env`, затем в `deploy/.env`:

| Переменная | Зачем |
| --- | --- |
| `RUCORD_JWT_SECRET` | Любая случайная строка ≥32 байт. Утечёт → у атакующего твои сессии. |
| `POSTGRES_PASSWORD` | Пароль БД. Дефолт `change-me` — не оставлять. |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | Доступ к object storage. Тоже не оставлять `change-me`. |
| `RUCORD_BOOTSTRAP_*` | Логин/пароль первого админа. Создаётся один раз на пустой БД. |
| `RUCORD_DOMAIN` (single-node) | `chat.example.com` либо `localhost`/IP для приватной сети. |
| `RUCORD_TLS_EMAIL` (single-node) | Email для Let's Encrypt либо литерал `internal` (self-signed). |
| `RUCORD_CORS_ORIGINS` (prod) | Список оригинов клиента через запятую, без `*`. Для Windows-клиента обязательно `tauri://localhost,http://tauri.localhost,https://tauri.localhost`. |
| `RUCORD_SFU_PUBLIC_IP` (single-node) | Внешний IP сервера (в LAN — LAN-адрес). Без него SFU в production не стартует, а вместе с ним не поднимется Caddy. |
| `ICE_TURN_URLS`, `ICE_TURN_SHARED_SECRET` (single-node) | Адрес и секрет TURN (coturn). Секрет: `openssl rand -hex 32`. |

Без правки этих значений сервер либо не стартует (JWT-секрет короче 32
байт), либо стартует с известными дефолтными паролями — что эквивалентно
открытой админке.

## Local: попробовать на ноутбуке

```bash
cp deploy/.env.example deploy/.env
# (поправить секреты как описано выше)

# 1) Поднять инфраструктуру (postgres, redis, minio)
docker compose -f deploy/local/docker-compose.yml --env-file deploy/.env up -d

# 2) Применить миграции (явный шаг — переиграется при добавлении новых)
docker compose -f deploy/local/docker-compose.yml --env-file deploy/.env run --rm migrate

# 3) Запустить Go-сервисы (в трёх терминалах либо через VSCode task `Run All`)
go run github.com/NotReptile/RuCord/services/core-api/cmd/core-api
go run github.com/NotReptile/RuCord/services/realtime/cmd/realtime
go run github.com/NotReptile/RuCord/services/worker/cmd/worker

# 4) Запустить десктоп-клиент
cd apps/desktop && npm install && npm run dev
```

Для локального режима (mesh-звонки без SFU) очисти `RUCORD_SFU_URL` в
`deploy/.env`, иначе `core-api` будет анонсировать несуществующий SFU.
Postgres в local-compose слушает порт `5433`.

Каждому терминалу нужны env-переменные из `deploy/.env`. На Windows проще
открыть проект в VSCode и нажать таск `Run All` — он экспортирует env,
поднимает инфру + миграции + все три сервиса + клиент.

Подробности: [docs/runbooks/local-development.md](docs/runbooks/local-development.md).

## Single-node: продакшн на одной машине

Один Linux-хост держит весь стек: Postgres, Redis, MinIO, Caddy (TLS
терминируется на нём), Go-сервисы.

```bash
cp deploy/.env.example deploy/.env
# (RUCORD_DOMAIN, RUCORD_TLS_EMAIL, секреты — всё из чек-листа выше)

# 1) Миграции
docker compose -f deploy/single-node/docker-compose.yml --env-file deploy/.env run --rm migrate

# 2) Весь стек: Go-сервисы собираются из исходников, Caddy слушает 80/443
docker compose -f deploy/single-node/docker-compose.yml --env-file deploy/.env up -d --build
```

На роутере и firewall нужны порты `80/tcp`, `443/tcp`, `3478/tcp+udp`,
`49160-49200/udp` и `50000/udp`.

Caddy выдаст TLS-сертификат через Let's Encrypt (если `RUCORD_TLS_EMAIL` —
почта) или self-signed (если `internal`). После этого `https://$RUCORD_DOMAIN`
отдаёт API и WebSocket; первый админ логинится бутстрап-паролем из
`RUCORD_BOOTSTRAP_PASSWORD`.

Подробности: [docs/runbooks/single-node.md](docs/runbooks/single-node.md).

## Бэкапы

```bash
deploy/backup.sh                       # ./backups/<UTC-ts>/
deploy/restore.sh ./backups/<UTC-ts>   # деструктивно, спросит yes/NO
```

Подробности: [docs/runbooks/backup-and-restore.md](docs/runbooks/backup-and-restore.md).

## Документация

- [docs/README.md](docs/README.md) — индекс wiki, ADR'ы, runbook'и.
- [docs/architecture/overview.md](docs/architecture/overview.md) — границы
  сервисов, runtime composition.
- [docs/security/overview.md](docs/security/overview.md) — auth, сессии,
  RBAC, секреты.
- [CHANGELOG.md](CHANGELOG.md) — история версий.
- [CONTRIBUTING.md](CONTRIBUTING.md) и [SECURITY.md](SECURITY.md).

## Принципы

- monorepo с явными границами;
- сервер — источник истины для домена;
- realtime — не source of truth, а доставка;
- local и single-node делят одну архитектуру, меняется только compose и конфиг.
