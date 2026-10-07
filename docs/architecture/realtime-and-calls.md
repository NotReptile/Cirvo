# Realtime And Calls

## Realtime Scope

The realtime node (`services/realtime`) is limited to:

- transport connection lifecycle (`/ws` WebSocket upgrade with a 30-second one-time ticket; legacy `access_token` remains temporarily);
- durable `RealtimeEnvelopeV2` journal with a seven-day replay window;
- presence events;
- typing events (`typing.start`, transient);
- signaling message transport (events `call.invite|offer|answer|ice|hangup` and `voice.offer|answer|ice|hangup|state`);
- broadcast fan-out by workspace, by user and by session (`hub.BroadcastWorkspace`, `hub.BroadcastUser`, `hub.BroadcastSession`).

It is not responsible for canonical message persistence, workspace membership or role evaluation. Postgres remains the source of truth; the journal only closes disconnect/reconnect gaps.

Реальный медиа-трафик через `realtime` не идёт. Он переносит только SDP/ICE и служебные события. Медиа-плоскость: SFU (`services/sfu`) для voice-каналов, прямое P2P-соединение для 1-к-1 звонков, coturn как TURN-relay. Решение зафиксировано в [ADR: SFU media path](../adr/adr-sfu-media-path.md).

## Resume protocol

- Every durable event has `version`, global `seq`, `eventId` and `occurredAt`.
- The desktop reconnects with its last acknowledged `cursor`.
- The connection is registered in paused mode, replay is queued first, and live frames are buffered until `sync.ready`.
- Missing, expired or oversized replay cursors produce `sync.required`; the desktop runs an authoritative generation-guarded REST snapshot and then acknowledges the supplied cursor.
- `typing.*` remains transient and is not journaled.

## Signaling Module

`services/realtime/internal/modules/signaling` relays `call.*` and `voice.*` envelopes between connected users. `voice.offer|answer|ice|hangup` нужны только mesh-режиму voice-каналов; `voice.state` (флаги screen/camera) используется и в SFU-режиме.

- Validation: payload ≤ 32 KiB, valid JSON, non-empty `call_id`, at least one of `target_user_id` / `target_session_id`.
- ACL: source and target must share at least one workspace; resolved via `workspace_members` with a 30 s in-memory cache (`membershipCache`).
- Authority injection: server overwrites `from_user_id` and `from_session_id` from the authenticated WS connection. Clients cannot spoof.
- Targeting: if `target_session_id` is set the envelope is delivered to that single connection; otherwise broadcast to all sessions of `target_user_id`. This lets callers reach any device of a user, and follow-up frames pin the conversation to the device that answered.

## Media Config (ICE)

`core-api` exposes `GET /api/v1/media/config` (Protected, модуль `ice`). `/api/v1/ice-servers` is a one-release compatibility alias и отдаёт тот же ответ. Клиент использует `/api/v1/media/config`.

Формат ответа (см. код: `services/core-api/internal/modules/ice/module.go`):

```json
{
  "iceServers": [
    { "urls": ["stun:..."] },
    { "urls": ["turn:...?transport=udp"], "username": "...", "credential": "..." }
  ],
  "mode": "sfu",
  "sfuUrl": "wss://host/sfu/ws",
  "turnExpiresAt": "2026-01-01T00:00:00Z"
}
```

- `mode` - `"sfu"`, если задан `RUCORD_SFU_URL`, иначе `"mesh"`.
- `sfuUrl` - значение `RUCORD_SFU_URL`; поле опускается, если SFU не развёрнут. Клиент выбирает SFU по наличию `sfuUrl`.
- `turnExpiresAt` - только если выданы временные TURN-credentials.
- Блок TURN попадает в `iceServers`, когда непуст список TURN URL; блок STUN - когда непуст список STUN.

Переменные `core-api`:

- `ICE_STUN_URLS` - comma-separated; defaults to `stun:stun.l.google.com:19302`.
- `ICE_TURN_URLS` - comma-separated UDP/TCP/TLS endpoints. Если пусто, берётся одиночный `ICE_TURN_URL`.
- `ICE_TURN_SHARED_SECRET` - coturn REST secret used to issue per-user one-hour HMAC credentials: `username = "<unix expiry>:<userId>"`, `credential = base64(HMAC-SHA1(secret, username))`.
- Static `ICE_TURN_USERNAME` / `ICE_TURN_CREDENTIAL` values are legacy fallback only (используются, пока секрет пуст).
- `RUCORD_SFU_URL` - адрес SFU-сигналинга, например `wss://<domain>/sfu/ws`.

Если запрос конфигурации не удался, клиент падает обратно на Google STUN и режим mesh (`voiceChannelManager.ensureIceServers`).

## TURN

- `single-node`: сервис `coturn` в `deploy/single-node/docker-compose.yml`, порты `3478` tcp/udp и relay `49160-49200/udp`. При непустом `ICE_TURN_SHARED_SECRET` coturn стартует с `--use-auth-secret` (временные credentials, их выдаёт `core-api`), иначе со статическими `--lt-cred-mech`. TLS/DTLS выключены (`--no-tls --no-dtls`), то есть `turns:` не поддерживается. `external-ip` резолвится из `RUCORD_DOMAIN` при старте.
- `local`: `deploy/local/docker-compose.yml` ships a coturn service under the `turn` profile (`docker compose --profile turn up coturn`) со статическими credentials. For local 1-on-1 development host candidates are usually sufficient and the TURN container does not need to run.

## Voice Channels

Участие в voice-канале - это строка в `channel_participants` (ключ `channel_id + session_id`, два устройства одного пользователя занимают два слота). Её пишет `core-api`: `POST /api/v1/channels/{id}/voice/join` отдаёт `{ channelId, self, others }`, `voice/leave` идемпотентен. События `voice.joined` / `voice.left` уходят всему workspace через `realtimebus`. Roster и флаги `screenSharing` / `cameraOn` ведёт `VoiceChannelManager` при любом транспорте медиа.

Транспорт медиа выбирается на уровне деплоя, а не канала: смешанного режима внутри одного канала нет, авто-перехода mesh -> SFU по числу участников нет.

| | mesh | SFU |
| --- | --- | --- |
| Когда | `RUCORD_SFU_URL` пуст (`local`) | `RUCORD_SFU_URL` задан (`single-node`) |
| Соединений на клиента | N-1 `RTCPeerConnection` | 2 (publisher и subscriber) |
| Сигналинг | `voice.*` через `realtime` | отдельный WebSocket `/sfu/ws` |
| Лимит канала | 5 | 50 |

### SFU flow

1. Клиент делает `POST /voice/join` (ACL, лимит, архивность канала проверяет `core-api`).
2. Клиент получает тикет: `POST /api/v1/channels/{channelId}/voice/sfu-ticket` (только для участника канала; TTL 30 с, одноразовый).
3. Клиент открывает `wss://<domain>/sfu/ws?ticket=...` (через Caddy). SFU проверяет тикет, живую сессию и строку в `channel_participants`.
4. Publisher PC: клиент - offerer (`pub.offer` / `pub.answer`). Subscriber PC: сервер - offerer (`sub.offer` / `sub.answer`). Разделение исключает glare. Кандидаты: `pub.ice`, `sub.ice`.
5. RTP клиентов принимается на один UDP-порт `RUCORD_SFU_UDP_PORT` (мимо Caddy) и пересылается подписчикам комнаты без транскодинга. Пока жив видеотрек, SFU раз в 2 секунды шлёт паблишеру PLI, чтобы новые зрители получили keyframe.

В коде SFU нет simulcast, серверного mute и active speaker (см. `services/sfu/internal/rtc`).

## Client Call State Machine

`apps/desktop/src/call/callManager.ts` owns the WebRTC lifecycle of 1-to-1 calls. Звонки всегда P2P (SFU не используется), TURN берётся из `/api/v1/media/config`; `CallSnapshot.via` показывает `relay` или `direct`.

States: `idle` → (`outgoing` | `incoming`) → `connecting` → `active` → `ended` → `idle`.

- One concurrent call. A second `call.invite` while not idle is auto-replied with `call.hangup{reason:"busy"}`.
- ICE candidates received before `setRemoteDescription` are queued and drained.
- Звонок начинается как аудио: `getUserMedia({ audio, video: false })` с constraints из `voiceSettings.ts` и опциональным шумоподавлением (`denoiser.ts`). Камера (`toggleCamera`) и демонстрация экрана (`toggleScreenShare`) включаются во время звонка и делят один video sender, поэтому одновременно работает только одно из них.
- UI consumes immutable `CallSnapshot` via `subscribe(listener)` and never touches `RTCPeerConnection`. `MediaStream` менеджеры отдают UI только для отображения (`getLocalStream` / `getRemoteStream`).

`VoiceChannelManager` (`voiceChannelManager.ts`) работает по той же схеме для voice-каналов. Состояния: `idle`, `joining`, `active`, `media-reconnecting`, `leaving`. В SFU-режиме медиа ведёт `SfuSession` (`sfuSession.ts`).

## Screen Share And Video

- Камера: constraints из `voiceSettings.ts`; размытие фона через Mediapipe (`videoEffects.ts`) с прозрачным fallback на исходный трек.
- Демонстрация экрана: если доступен Tauri-захват (`tauriScreenCapture.ts`, Rust-команды `screen_*`), используется собственный picker и pipeline без браузерной плашки. Иначе (web, Firefox/Safari, ошибка команды) - `getDisplayMedia`. Системный звук демонстрации (`screenAudio.ts`) есть только на Windows.
- Качество демонстрации задаётся пресетом `ScreenShareQuality` (разрешение, fps, `maxBitrate`); он применяется через `setParameters` на video sender.

## Media recovery

SFU is the production voice/video/screen transport. Initial SFU failure rolls back the voice membership. After activation, signaling or ICE failure moves the client to `media-reconnecting`; publisher/subscriber PCs are rebuilt with fresh credentials and current local tracks using exponential backoff (500 мс * 2^n, не больше 30 с). Mesh is an explicit development fallback only.
