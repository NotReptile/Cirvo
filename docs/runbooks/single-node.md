# Single-Node Runbook

Один хост держит весь стек: Postgres, Redis, MinIO, Caddy (reverse-proxy с TLS)
и четыре Go-сервиса (`core-api`, `realtime`, `sfu`, `worker`). Caddy терминирует TLS и
проксирует HTTP/WS к сервисам.

## Перед первым запуском

1. `cp deploy/.env.example deploy/.env` и поменять минимум:
   - `POSTGRES_PASSWORD`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` — секреты;
   - `CIRVO_JWT_SECRET` — ≥ 32 байт случайной строки;
   - `CIRVO_DOMAIN` — публичное имя хоста (`chat.example.com`) либо
     `localhost`/IP для приватной сети;
   - `CIRVO_TLS_EMAIL` — почта для Let's Encrypt, либо литерал `internal`
     для self-signed сертификата;
   - `CIRVO_CORS_ORIGINS` — конечный allow-list оригинов клиента
     (без `*`). Для Windows-клиента обязательно все три Tauri-оригина:
     `tauri://localhost,http://tauri.localhost,https://tauri.localhost`.
     WebView2 на Windows ходит с `http://tauri.localhost`, и без него клиент
     получит CORS-ошибку уже на экране «Подключение к серверу»;
   - `CIRVO_BOOTSTRAP_EMAIL`, `_USERNAME`, `_PASSWORD` — данные первого
     администратора (создаётся один раз на пустой БД, пакет
     `core-api/internal/bootstrap`). Нужны **все три**, иначе администратор не
     создаётся. См. раздел «Пользователи» ниже.
   - `ICE_TURN_URLS`, `ICE_TURN_SHARED_SECRET` — TURN UDP/TCP и временные credentials;
   - `CIRVO_SFU_URL`, `CIRVO_SFU_PUBLIC_IP`, `CIRVO_SFU_UDP_PORT` — публичный SFU.

`CIRVO_SFU_PUBLIC_IP` обязателен: в production (`CIRVO_ENV=production`) SFU
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
- `minio` (S3-совместимое хранилище, собирается из исходников, см. ниже);
- `reverse-proxy` (Caddy на 80/443);
- `core-api`, `realtime`, `worker` — Go-сервисы, собираются из
  `deploy/Dockerfile.service`;
- `coturn` и `sfu` — основной production media path.

Сервис `migrate` существует в compose-файле, но привязан к `profiles:
["tools"]` — `up` его не трогает, нужно явно вызывать `run --rm migrate`.

## MinIO собирается из исходников

Публичные образы MinIO (`minio/minio`, `minio/mc`, `quay.io/minio/minio`)
больше не отдаются анонимно, а репозитории проекта заархивированы. Поэтому
`deploy/minio/Dockerfile` собирает сервер и клиент `mc` из исходников на
закреплённых коммитах (`deploy/minio/MINIO_REF` и `MC_REF`). Первая сборка
занимает 3–5 минут, дальше берётся из кэша Docker. Обновить версию: поменять
коммит в `MINIO_REF` или `MC_REF`, пересобрать (`docker compose ... build minio
mc`) и проверить на копии данных.

Апстрим в архиве: обновлений безопасности не будет. MinIO не публикуется
наружу (порты не проброшены), доступ только через `core-api`, что снижает риск,
но замена на поддерживаемое S3-совместимое хранилище остаётся в планах.

## Запуск сервисов

Все Go-сервисы собираются `deploy/Dockerfile.service` и запускаются тем же
compose. SFU имеет обязательный healthcheck и в production отказывается
стартовать без `CIRVO_SFU_PUBLIC_IP`.

## Пользователи

**Первый администратор.** При старте на пустой базе `core-api` создаёт
администратора из `CIRVO_BOOTSTRAP_*` (вместе с воркспейсом «Главный сервер» и
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
password_change_required`; WebSocket `/ws` и `/sfu/ws` тоже закрыты), пока он не
задаст свой пароль. Когда он это сделает, все остальные его сессии отзываются
(временный пароль мог попасть не в те руки). Явный `password` вместе
с `"mustChangePassword": false` создаёт постоянный пароль. Новый пользователь
никогда не становится администратором; создание попадает в журнал аудита
(`user.created`). Лимит «Лимит пользователей» действует и на создание.

Без `joinWorkspaceId` человек не увидит ни одного воркспейса, пока его не
пригласят: укажи воркспейс или передай инвайт.

## TLS

- **Let's Encrypt** (`CIRVO_TLS_EMAIL=user@example.com`): Caddy выпустит
  сертификат автоматически при первом обращении к `https://$CIRVO_DOMAIN`.
  Требования: домен резолвится в IP хоста, 80/443 доступны извне.
- **Self-signed** (`CIRVO_TLS_EMAIL=internal`): Caddy выдаст сертификат
  через встроенный CA. Корневой сертификат лежит в named-volume `caddy-data`
  (`/data/caddy/pki/authorities/local/root.crt`) — добавь его в trust-store
  клиента, иначе браузер/Tauri будет жаловаться.

### Полностью без внешних служб (локальный домен)

Схема для домашнего сервера, который не должен зависеть ни от DuckDNS, ни от
Let's Encrypt: имя в зарезервированной зоне `home.arpa` (RFC 8375), которое
отдаёт свой DNS (например, AdGuard с записью `*.home.arpa`), и внутренний УЦ Caddy.

```ini
CIRVO_DOMAIN=cirvo.home.arpa
CIRVO_TLS_EMAIL=internal
CIRVO_CORS_ORIGINS=...,https://cirvo.home.arpa
ICE_TURN_URLS=turn:cirvo.home.arpa:3478?transport=udp,turn:cirvo.home.arpa:3478?transport=tcp
CIRVO_SFU_URL=wss://cirvo.home.arpa/sfu/ws
CIRVO_SFU_PUBLIC_IP=192.168.1.10   # адрес сервера в локальной сети
```

- Голос из локальной сети и по VPN (например, WireGuard в ту же сеть) работает;
  без VPN из интернета до `192.168.x.x` не достучаться.
- Корневой сертификат Caddy (`root.crt`) нужно один раз установить в хранилище
  доверенных корневых сертификатов Windows на каждом компьютере, где стоит клиент.
- Имя `cirvo.home.arpa` должно резолвиться на клиентах: через DNS роутера с
  условной пересылкой зоны `home.arpa` на ваш DNS-сервер или напрямую через него в VPN.

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

CORS allow-list инфорсится в core-api через `CIRVO_CORS_ORIGINS` — Caddy
сам CORS не делает.

## Проверка после запуска

Публичный деплой (один DNS-имя, валидный TLS, проброс портов из списка выше)
считается рабочим, когда:

1. `https://$CIRVO_DOMAIN/readyz` отвечает `200`;
2. подключается WebSocket `/ws` (вход в клиент, сообщения доходят без перезагрузки);
3. подключается `/sfu/ws` и в голосовом канале слышно участников;
4. TURN выдаёт relay-адрес (админка → Метрики → «Проверить STUN/TURN»);
5. в логах `sfu` растут счётчики RTP-байтов.

Команды для разбора отказов: [diagnostics.md](diagnostics.md).

## Внешние зависимости

Чат, вложения и голос работают на вашем сервере и не обращаются к чужим
сервисам (STUN, CDN, шрифты и модели клиента внутри приложения). Что ещё
использует интернет:

| Что | Зачем | Когда нужно |
| --- | --- | --- |
| Let's Encrypt (Caddy) | Сертификат для `CIRVO_DOMAIN` | Только публичный домен. Для локального домена поставьте `CIRVO_TLS_EMAIL=internal` (см. «Полностью без внешних служб») |
| Внешний DNS (например DuckDNS) | Имя сервера для клиентов | Только если нет своего DNS. Локальный домен `*.home.arpa` его не требует |
| GitHub Releases | Первичное скачивание установщика | Чат и последующие обновления клиента от GitHub не зависят |
| Предпросмотр ссылок (`worker`) | Сервер скачивает страницу по ссылке из сообщения | Только когда пользователь отправил внешнюю ссылку; без доступа в интернет просто нет превью |
| Docker Hub, `proxy.golang.org` | Образы и зависимости | Только при сборке и обновлении |

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

### Переход со старого названия RuCord

Проект назывался RuCord, и переменные окружения начинались с `RUCORD_`. Теперь
они начинаются с `CIRVO_`. Сами сервисы продолжат понимать `RUCORD_*`
(с предупреждением в логе), но compose-файлы подставляют только новые имена,
поэтому перед обновлением переименуй переменные в `deploy/.env`:

```bash
cp deploy/.env deploy/.env.bak
sed -i 's/^RUCORD_/CIRVO_/' deploy/.env
```

Имена базы и пользователя Postgres, бакета MinIO и TURN-учётных данных по
умолчанию (`rucord`) менять не нужно: от них зависят существующие данные.
Не переименовывай каталог с репозиторием на сервере (или задай прежний
`COMPOSE_PROJECT_NAME`): от него зависят имена Docker-томов, и с новым именем
compose создал бы пустые тома.

Сертификаты Let's Encrypt живут в volume `caddy-data` и обновляются Caddy
автоматически. При смене `CIRVO_DOMAIN` старые сертификаты не чистятся —
безопасно оставить.
