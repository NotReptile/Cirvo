# Single-Node Runbook

Один хост держит весь стек: Postgres, Redis, MinIO, Caddy (reverse-proxy с TLS)
и четыре Go-сервиса (`core-api`, `realtime`, `sfu`, `worker`). Caddy терминирует TLS и
проксирует HTTP/WS к сервисам.

## Перед первым запуском

1. `cp deploy/.env.example deploy/.env` и поменять минимум:
   - `POSTGRES_PASSWORD`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` — секреты;
   - `RUCORD_JWT_SECRET` — ≥ 32 байт случайной строки;
   - `RUCORD_DOMAIN` — публичное имя хоста (`chat.example.com`) либо
     `localhost`/IP для приватной сети;
   - `RUCORD_TLS_EMAIL` — почта для Let's Encrypt, либо литерал `internal`
     для self-signed сертификата;
   - `RUCORD_CORS_ORIGINS` — конечный allow-list оригинов клиента
     (без `*`). Для Windows-клиента обязательно все три Tauri-оригина:
     `tauri://localhost,http://tauri.localhost,https://tauri.localhost`.
     WebView2 на Windows ходит с `http://tauri.localhost`, и без него клиент
     получит CORS-ошибку уже на экране «Подключение к серверу»;
   - `RUCORD_BOOTSTRAP_EMAIL`, `_USERNAME`, `_PASSWORD` — данные первого
     администратора (создаётся один раз на пустой БД, пакет
     `core-api/internal/bootstrap`). Нужны **все три**, иначе администратор не
     создаётся. См. раздел «Пользователи» ниже.
   - `ICE_TURN_URLS`, `ICE_TURN_SHARED_SECRET` — TURN UDP/TCP и временные credentials;
   - `RUCORD_SFU_URL`, `RUCORD_SFU_PUBLIC_IP`, `RUCORD_SFU_UDP_PORT` — публичный SFU.

`RUCORD_SFU_PUBLIC_IP` обязателен: в production (`RUCORD_ENV=production`) SFU
без него не стартует, а `reverse-proxy` ждёт `sfu: service_healthy`, то есть
не поднимется весь стек. В LAN-сценарии укажи LAN-адрес сервера.

На роутере и host firewall открой `80/tcp`, `443/tcp`, `3478/tcp+udp`,
`49160-49200/udp` и `50000/udp`. UDP 443 не нужен: HTTP/3 в Caddyfile
отключён (`protocols h1 h2`, из-за WebView2).

## Запуск инфраструктуры + edge

Сначала миграции (отдельной командой — иначе при добавлении новых
миграций они не пере-исполнятся без `--force-recreate`):

```bash
docker compose \
  -f deploy/single-node/docker-compose.yml \
  --env-file deploy/.env \
  run --rm migrate
```

Затем поднимаем сам стек:

```bash
docker compose \
  -f deploy/single-node/docker-compose.yml \
  --env-file deploy/.env \
  up -d
```

Поднимаются:

- `postgres` (порт наружу не публикуется — доступ через сервисы);
- `redis`;
- `minio` (S3-совместимое хранилище);
- `reverse-proxy` (Caddy на 80/443);
- `core-api`, `realtime`, `worker` — Go-сервисы, собираются из
  `deploy/Dockerfile.service`;
- `coturn` и `sfu` — основной production media path.

Сервис `migrate` существует в compose-файле, но привязан к `profiles:
["tools"]` — `up` его не трогает, нужно явно вызывать `run --rm migrate`.

## Запуск сервисов

Все Go-сервисы собираются `deploy/Dockerfile.service` и запускаются тем же
compose. SFU имеет обязательный healthcheck и в production отказывается
стартовать без `RUCORD_SFU_PUBLIC_IP`.

## Пользователи

**Первый администратор.** При старте на пустой базе `core-api` создаёт
администратора из `RUCORD_BOOTSTRAP_*` (вместе с воркспейсом «Главный сервер» и
каналом `#general`). Пароль остаётся в окружении контейнера и виден через
`docker inspect`, поэтому после первого входа убери эти переменные из `deploy/.env`
и смени пароль. Если переменные не заданы, первым администратором станет тот, кто
первым вызовет регистрацию, поэтому не оставляй пустой сервер открытым в интернете.

**Новые люди.** По умолчанию регистрация открыта (`Настройки сервера → Открытая
регистрация`). Для закрытого сообщества отключи её и создавай аккаунты сам:
`POST /api/v1/server/users` (только администратор сервера, `is_root`):

```json
{ "email": "ivan@example.com", "username": "ivan", "displayName": "Иван",
  "joinWorkspaceId": "<uuid воркспейса>" }
```

Без поля `password` сервер генерирует временный пароль (16 знаков) и возвращает
его **один раз** в `temporaryPassword`. При первом входе человеку доступны только
смена пароля, `GET /api/v1/users/me` и выход (остальное отвечает `403
password_change_required`), пока он не задаст свой пароль. Явный `password` вместе
с `"mustChangePassword": false` создаёт постоянный пароль. Новый пользователь
никогда не становится администратором; создание попадает в журнал аудита
(`user.created`). Лимит «Лимит пользователей» действует и на создание.

Без `joinWorkspaceId` человек не увидит ни одного воркспейса, пока его не
пригласят: укажи воркспейс или передай инвайт.

## TLS

- **Let's Encrypt** (`RUCORD_TLS_EMAIL=user@example.com`): Caddy выпустит
  сертификат автоматически при первом обращении к `https://$RUCORD_DOMAIN`.
  Требования: домен резолвится в IP хоста, 80/443 доступны извне.
- **Self-signed** (`RUCORD_TLS_EMAIL=internal`): Caddy выдаст сертификат
  через встроенный CA. Корневой сертификат лежит в named-volume `caddy-data`
  (`/data/caddy/pki/authorities/local/root.crt`) — добавь его в trust-store
  клиента, иначе браузер/Tauri будет жаловаться.

## Что отдаёт edge

- `GET /healthz`, `/readyz` — наружу для health-чека ALB/uptime;
- `GET/POST /api/*` → core-api:8080;
- `GET /ws*` → realtime:8090 (WebSocket, таймауты 1h);
- `GET /sfu/ws*` → sfu:8095; RTP идёт напрямую на `50000/udp`;
- всё остальное — `404`.

## Security headers

Caddy выставляет:

- `Strict-Transport-Security` (HSTS, 180 дней, без preload);
- `X-Frame-Options: DENY`;
- `X-Content-Type-Options: nosniff`;
- `Referrer-Policy: strict-origin-when-cross-origin`;
- `Permissions-Policy` — `camera=(self)`, `microphone=(self)`,
  `display-capture=(self)` (нужны для звонков), остальное запрещено;
- `Cross-Origin-Opener-Policy: same-origin`;
- Снимает `Server` (не палим версию Caddy).

CORS allow-list инфорсится в core-api через `RUCORD_CORS_ORIGINS` — Caddy
сам CORS не делает.

## Обновление

Go-сервисы собираются на хосте из исходников, поэтому `pull` их не обновляет.
Обновление: забрать код, применить миграции, пересобрать контейнеры.

```bash
git pull
docker compose -f deploy/single-node/docker-compose.yml --env-file deploy/.env run --rm migrate
docker compose -f deploy/single-node/docker-compose.yml --env-file deploy/.env up -d --build
```

Перед обновлением сделай бэкап (`deploy/backup.sh`). Клиенты обновляются
отдельно, см. [desktop-release.md](desktop-release.md).

Сертификаты Let's Encrypt живут в volume `caddy-data` и обновляются Caddy
автоматически. При смене `RUCORD_DOMAIN` старые сертификаты не чистятся —
безопасно оставить.
