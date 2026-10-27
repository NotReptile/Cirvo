# RuCord

Self-host чат и голос для небольших сообществ: свой «Discord», который вы запускаете сами.

[English](README.md)

[![smoke](https://github.com/NotReptile/RuCord/actions/workflows/smoke.yml/badge.svg)](https://github.com/NotReptile/RuCord/actions/workflows/smoke.yml)
[![desktop-check](https://github.com/NotReptile/RuCord/actions/workflows/desktop-check.yml/badge.svg)](https://github.com/NotReptile/RuCord/actions/workflows/desktop-check.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

RuCord рассчитан на дружеские кружки и небольшие и средние сообщества (десятки или сотни пользователей на инстанс). Один инстанс = один сервер; внутри допустимо несколько workspace'ов. Сервер работает на Linux в Docker, основной клиент: десктоп-приложение на Tauri для Windows.

> **Статус: ранняя версия.** Windows-клиент и серверный стек выпускаются как ранняя версия. Web и Android-клиенты запланированы, но пока недоступны. Текущая версия и список изменений: [CHANGELOG.md](CHANGELOG.md).

## Возможности

- Рабочие пространства с текстовыми каналами, категориями, вложениями и реакциями
- Треды и форум-каналы
- Личные сообщения и друзья
- Голосовые каналы и видеозвонки (mesh для малых звонков, SFU для групп), демонстрация экрана, шумоподавление
- Роли и права (RBAC) с доступом на уровне каналов
- Приглашения со сроком действия, создание пользователей администратором с принудительной сменой пароля
- Присутствие и статусы, профили, уведомления
- Поиск по сообщениям и превью ссылок
- Журнал аудита и админ-панель (регистрация, размер вложений, квота хранилища)
- Windows-клиент с подписанными автообновлениями
- Для голоса не нужны внешние службы: STUN/TURN обеспечивает ваш собственный coturn

## Архитектура

| Компонент | Описание | Порт |
| --- | --- | --- |
| `apps/desktop` | Клиент: TypeScript, Vite, Tauri 2 | dev-сервер 1420 |
| `services/core-api` | Go HTTP API | 8080 |
| `services/realtime` | Go WebSocket: presence, signaling, журнал событий | 8090 |
| `services/sfu` | Go SFU (pion) для группового голоса и видео | 8095, медиа по UDP 50000 |
| `services/worker` | Go фоновые задачи: превью, ретеншн, уведомления | - |

Инфраструктура: Postgres, Redis, MinIO (объектное хранилище), coturn (TURN, порт 3478) и Caddy (TLS и reverse-proxy).

```
                  +-----------+
  Десктоп-клиент  |   Caddy   |  TLS, reverse-proxy
  --------------> | 80 / 443  |
                  +-----+-----+
                        | HTTP / WebSocket
        +---------------+---------------+
        |               |               |
   core-api :8080  realtime :8090   sfu :8095  (медиа: UDP 50000)
        |               |               |
        +------+--------+---------------+
               |
     Postgres, Redis, MinIO        coturn :3478 (TURN)

   worker: фоновые задачи (превью, ретеншн, уведомления)
```

## Быстрый старт

### Поднять свой сервер

Требуется: Docker с `docker compose`.

```bash
cp deploy/.env.example deploy/.env
# отредактируйте deploy/.env: секреты, домен, CORS, публичный IP для SFU, TURN

docker compose -f deploy/single-node/docker-compose.yml --env-file deploy/.env run --rm migrate
docker compose -f deploy/single-node/docker-compose.yml --env-file deploy/.env up -d
```

Перед первым запуском обязательно поменяйте минимум `RUCORD_JWT_SECRET` (не короче 32 байт), `POSTGRES_PASSWORD`, `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`, значения `RUCORD_BOOTSTRAP_*` (первый администратор), `RUCORD_DOMAIN` (например `chat.example.com`), `RUCORD_CORS_ORIGINS` (без `*`; для Windows-клиента должен включать `tauri://localhost,http://tauri.localhost,https://tauri.localhost`), `RUCORD_SFU_PUBLIC_IP` (`<PUBLIC_IP>`) и настройки TURN (`ICE_TURN_URLS`, `ICE_TURN_SHARED_SECRET`).

Порты, которые нужно открыть: `80/tcp`, `443/tcp`, `3478/tcp+udp`, `49160-49200/udp` и `50000/udp`.

Полное руководство: [docs/runbooks/single-node.md](docs/runbooks/single-node.md).

### Разработка локально

Требуется: Docker, Go 1.26+, Node.js 20.19+ или 22.12+ (в CI используется Node 22). Для сборки exe десктоп-клиента также нужны Rust (stable) и MSVC Build Tools.

```bash
cp deploy/.env.example deploy/.env
# для локального режима задайте RUCORD_SFU_URL= (пусто); экспортируйте переменные из deploy/.env в оболочку

docker compose --env-file deploy/.env -f deploy/local/docker-compose.yml up -d postgres redis minio
docker compose --env-file deploy/.env -f deploy/local/docker-compose.yml run --rm migrate

# каждая команда в своём терминале, с экспортированным окружением
go run github.com/NotReptile/RuCord/services/core-api/cmd/core-api
go run github.com/NotReptile/RuCord/services/realtime/cmd/realtime
go run github.com/NotReptile/RuCord/services/worker/cmd/worker

# клиент
npm ci
npm run dev:desktop      # dev-сервер Vite на http://127.0.0.1:1420
```

Подробности: [docs/runbooks/local-development.md](docs/runbooks/local-development.md).

## Десктоп-клиент

Клиент рассчитан на Windows 10/11 (64-бит). Скачайте установщик `RuCord_<версия>_x64-setup.exe` из [GitHub Releases](https://github.com/NotReptile/RuCord/releases), запустите его и введите адрес сервера (например `chat.example.com`). Установщик пока не подписан Authenticode, поэтому SmartScreen покажет предупреждение: выберите «Подробнее», затем «Выполнить в любом случае». Обновления проверяются отдельным ключом подписи. См. [docs/runbooks/windows-client.md](docs/runbooks/windows-client.md) и [docs/runbooks/desktop-release.md](docs/runbooks/desktop-release.md).

Сборка из исходников:

```bash
npm ci
npm run build:desktop                           # web-бандл
npm --workspace apps/desktop run tauri build    # exe для Windows; нужны Rust и ключ подписи
```

## Структура репозитория

| Путь | Что |
| --- | --- |
| `apps/desktop` | Десктоп-клиент (TypeScript, Vite, Tauri 2; `src-tauri` — Rust-оболочка) |
| `services/core-api` | HTTP API; модули в `internal/modules/*` |
| `services/realtime` | WebSocket-сервис |
| `services/sfu` | SFU для группового голоса и видео |
| `services/worker` | Фоновые задачи |
| `libs/shared-go` | Общие Go-пакеты (config, jwtauth, ratelimit, retention, wsticket, ...) |
| `libs/shared-ts`, `libs/contracts` | Общие TS-типы и контракты |
| `db/migrations` | Нумерованные миграции golang-migrate (`up` и `down`) |
| `deploy/` | `local/` (разработка) и `single-node/` (продакшн) |
| `docs/` | Документация |

## Документация

Начните с [docs/README.md](docs/README.md). Подробная документация ведётся на русском.

## Участие в разработке

1. Сделайте форк и создайте ветку от `main`.
2. Внесите изменения в стиле окружающего кода (см. `.editorconfig`).
3. Перед PR прогоните:

   ```bash
   npm ci
   npm run check:desktop
   npm --workspace apps/desktop test
   go build ./libs/shared-go/... ./services/core-api/... ./services/realtime/... ./services/sfu/... ./services/worker/...
   go test -race ./libs/shared-go/... ./services/core-api/... ./services/realtime/... ./services/sfu/...
   ```

4. Откройте pull request в `main`.

Правила:

- Сообщения коммитов можно писать на любом языке; желателен стиль conventional commits (`feat(scope): ...`, `fix(scope): ...`).
- Новое право = новая константа `permission.Action` и запись в матрице. Никаких `if role == "..."` в обработчиках.
- Миграции БД: только новый файл со следующим номером и парой `up`/`down`. Старые миграции не редактировать.
- Не коммитьте секреты (`deploy/.env`, токены, ключи, пароли).

## Безопасность

О найденных уязвимостях сообщайте приватно. См. [SECURITY.md](SECURITY.md).

## Лицензия

[MIT](LICENSE) (c) 2026 NotReptile
