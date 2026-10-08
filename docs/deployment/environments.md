# Environments

Deployment profile and runtime stage are separate concerns. A profile describes topology, while a stage describes operational strictness such as `dev`, `test` or `prod`.

Поддерживаются два профиля: `local` и `single-node`. Публичный деплой делается профилем `single-node`.

## Local

- developer workstation;
- minimal dependencies;
- first admin provisioned via `RUCORD_BOOTSTRAP_*` env at startup, or self-register via `/auth/register`;
- relaxed domain and TLS assumptions.

Состав (`deploy/local/docker-compose.yml`): Postgres (на хосте порт `5433`), Redis, MinIO. Профили compose: `tools` (контейнер `migrate`), `turn` (coturn со статическими credentials), `public-ip` (HTTP-прокси Caddy без TLS для проверки с удалённых клиентов по статическому IP). Go-сервисы `core-api`, `realtime`, `worker` запускаются на хосте, клиент - через `npm run dev`. `RUCORD_ENV=local`, `RUCORD_STAGE=dev` по умолчанию.

Медиа: SFU и coturn в compose по умолчанию не входят. Пока `RUCORD_SFU_URL` пуст, `core-api` отдаёт `mode: "mesh"`, voice-каналы работают в mesh (до 5 участников), а 1-к-1 звонкам хватает host-кандидатов и STUN. Прокси `public-ip` не маршрутизирует `/sfu/ws` (только `/ws`, `/api/*`, `/healthz`, `/readyz`).

## Single-Node

- one host with all runtime units;
- reverse proxy and TLS may be colocated;
- suitable for small self-hosted deployments.

`deploy/single-node/docker-compose.yml` - единственный актуальный production-манифест. Он поднимает: `postgres`, `redis`, `minio`, `reverse-proxy` (Caddy, TLS), Go-сервисы `core-api`, `realtime`, `worker`, `sfu` (образы собираются из `deploy/Dockerfile.service`) и `coturn`. Миграции - отдельной командой `run --rm migrate` (профиль `tools`). Сервисам задано `RUCORD_ENV=production`, `RUCORD_STAGE=prod`.

Медиа в этом профиле:

- `sfu` и `coturn` стартуют всегда и являются основным медиа-путём. `RUCORD_SFU_URL` по умолчанию равен `wss://${RUCORD_DOMAIN}/sfu/ws`, поэтому voice-каналы идут через SFU (лимит 50). Решение: [ADR: SFU media path](../adr/adr-sfu-media-path.md).
- В `RUCORD_ENV=production` `sfu` не стартует без `RUCORD_SFU_PUBLIC_IP`; `reverse-proxy` ждёт `sfu` в состоянии healthy, поэтому без этой переменной не поднимется весь стек.
- Маршруты Caddy: `/ws*` в `realtime:8090`, `/sfu/ws*` в `sfu:8095`, `/api/*`, `/healthz`, `/readyz` в `core-api:8080`, остальное `404`. Медиа (RTP на `RUCORD_SFU_UDP_PORT`, по умолчанию `50000/udp`) и TURN идут мимо Caddy напрямую.
- Порты наружу: `80/tcp`, `443/tcp`, `3478/tcp+udp`, `49160-49200/udp` (relay coturn), `RUCORD_SFU_UDP_PORT/udp`. Подробно: [runbooks/single-node.md](../runbooks/single-node.md).
- У сервиса `sfu` в compose нет профиля, он включён всегда.

## Публичный деплой

Публичный деплой делается профилем `single-node`: публичный DNS, TLS (Let's Encrypt через `RUCORD_TLS_EMAIL`), проброс портов из списка выше. Пошагово: [runbooks/single-node.md](../runbooks/single-node.md).

Профиль в compose задаёт `RUCORD_ENV=production`, а не имя профиля; по значению `production` код различает только SFU (проверка `RUCORD_SFU_PUBLIC_IP`).
