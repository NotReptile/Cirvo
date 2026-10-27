# ADR: SFU Media Path

## Status

Accepted. Реализовано в `services/sfu`, `deploy/single-node/docker-compose.yml` и клиенте (`apps/desktop/src/call/sfuSession.ts`). Уточняет [ADR: Media Boundary](adr-media-boundary.md): SFU и TURN остаются вне `core-api`.

## Context

Mesh в voice-каналах требует от каждого клиента N-1 `RTCPeerConnection`; практический потолок около 5 участников (`meshLimit` в `core-api/internal/modules/voice`). Для групповых каналов с видео и демонстрацией экрана нужен сервер, который пересылает RTP между участниками. Клиенты за NAT дополнительно требуют TURN.

## Decision

- Media-плоскость voice-каналов - отдельный Go-сервис `services/sfu` на pion/webrtc v4. Он пересылает RTP без транскодинга; комната равна voice-каналу.
- Два `RTCPeerConnection` на клиента: publisher (offerer - клиент) и subscriber (offerer - сервер). Так исключён glare, perfect negotiation не нужен.
- Сигналинг SFU - собственный WebSocket `/sfu/ws`, а не relay через `realtime`: SFU сам сторона переговоров. Caddy проксирует `/sfu/ws*` на порт `8095`.
- Доступ: одноразовый тикет (`POST /api/v1/channels/{channelId}/voice/sfu-ticket`, TTL 30 с, Redis, `purpose=sfu`, привязан к каналу). Кроме тикета SFU проверяет живую сессию в `user_sessions` и строку в `channel_participants`. ACL, лимит участников и архивность канала остаются в `core-api` (`POST /voice/join`), SFU им доверяет.
- Медиа идёт на один UDP-порт (`CIRVO_SFU_UDP_PORT`, ICE UDPMux), мимо Caddy. Публичный адрес задаётся `CIRVO_SFU_PUBLIC_IP` (NAT 1:1 host-кандидаты). Серверные PeerConnection работают без ICE-серверов, TURN - забота клиента.
- TURN - отдельный контейнер `coturn`. Клиентская ICE-конфигурация выдаётся через `core-api`: `GET /api/v1/media/config` возвращает `iceServers`, `mode`, `sfuUrl`, `turnExpiresAt`. TURN-credentials временные: HMAC от `ICE_TURN_SHARED_SECRET`, TTL 1 час.
- Режим выбирается деплоем, а не каналом. Непустой `CIRVO_SFU_URL` даёт `mode: "sfu"` и лимит канала 50. Пустой даёт `mode: "mesh"` и лимит 5. Mesh остаётся режимом локальной разработки (`deploy/local` не содержит SFU). Если клиент не может получить конфигурацию медиа, он не включает mesh как запасной режим: голосовая функция сообщает об ошибке конфигурации.
- 1-к-1 звонки не используют SFU: они всегда P2P с TURN как fallback.
- `single-node`: `sfu` и `coturn` запускаются всегда. В `CIRVO_ENV=production` SFU без `CIRVO_SFU_PUBLIC_IP` не стартует.

## Rationale

- pion/webrtc - чистый Go: одна кодовая база и один toolchain с остальными сервисами, без внешнего медиасервера.
- Два PeerConnection на клиента вместо N-1 снимают потолок mesh и нагрузку на upstream клиента.
- Решения о доступе остаются в одном месте (`core-api`), поэтому SFU не дублирует модель прав.
- Один UDP-порт упрощает проброс через docker и NAT до одной строки firewall.
- Глобальный режим деплоя проще, чем выбор транспорта по числу участников.

## Consequences

- SFU напрямую читает Postgres (`user_sessions`, `channel_participants`) и Redis (тикеты). Он зависит от схемы, которой владеет `core-api`.
- Комнаты хранятся в памяти процесса (`rtc.Manager`). Горизонтального масштабирования и кластера SFU нет; рестарт процесса рвёт все комнаты, клиенты переподключаются с exponential backoff и перестраивают PeerConnection.
- Нет смешанного режима в одном канале и автоматического перехода mesh -> SFU. Simulcast, серверного mute и active speaker в SFU нет (keyframe запрашивается периодическим PLI).
- Firewall single-node включает `CIRVO_SFU_UDP_PORT/udp` и relay-диапазон coturn `49160-49200/udp`. coturn запущен без TLS (`turns:` недоступен).
- `deploy/single-node` обязан задавать `CIRVO_SFU_PUBLIC_IP`; без него reverse-proxy не поднимется (ждёт `sfu` в состоянии healthy).
