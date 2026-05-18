# Realtime And Calls

## Realtime Scope

The realtime node (`services/realtime`) is limited to:

- transport connection lifecycle (`/ws` WebSocket upgrade with `access_token` query, session liveness check, presence snapshot);
- presence events;
- signaling message transport (events `call.invite|offer|answer|ice|hangup`);
- broadcast fan-out by user and by session (`hub.BroadcastUser`, `hub.BroadcastSession`).

It is not responsible for canonical message persistence, workspace membership or role evaluation.

## Signaling Module

`services/realtime/internal/modules/signaling` relays `call.*` envelopes between connected users.

- Validation: payload ≤ 32 KiB, valid JSON, non-empty `call_id`, at least one of `target_user_id` / `target_session_id`.
- ACL: source and target must share at least one workspace; resolved via `workspace_members` with a 30 s in-memory cache (`membershipCache`).
- Authority injection: server overwrites `from_user_id` and `from_session_id` from the authenticated WS connection. Clients cannot spoof.
- Targeting: if `target_session_id` is set the envelope is delivered to that single connection; otherwise broadcast to all sessions of `target_user_id`. This lets callers reach any device of a user, and follow-up frames pin the conversation to the device that answered.

## ICE Configuration

`core-api` exposes `GET /api/v1/ice-servers` (Protected). It returns `{ iceServers: RTCIceServer[] }`, built from env:

- `ICE_STUN_URLS` - comma-separated; defaults to `stun:stun.l.google.com:19302`.
- `ICE_TURN_URL`, `ICE_TURN_USERNAME`, `ICE_TURN_CREDENTIAL` - optional; if `ICE_TURN_URL` is empty only STUN is returned.

`deploy/local/docker-compose.yml` ships a coturn service under the `turn` profile (`docker compose --profile turn up coturn`). For local 1-on-1 development host candidates are usually sufficient and the TURN container does not need to run.

## Client Call State Machine

`apps/desktop/src/call/callManager.ts` owns the WebRTC lifecycle.

States: `idle` → (`outgoing` | `incoming`) → `connecting` → `active` → `ended` → `idle`.

- One concurrent call. A second `call.invite` while not idle is auto-replied with `call.hangup{reason:"busy"}`.
- ICE candidates received before `setRemoteDescription` are queued and drained.
- Local stream is `getUserMedia({ audio: true })` only in MVP. Video is reserved.
- UI consumes immutable `CallSnapshot` via `subscribe(listener)` and never touches `RTCPeerConnection`.

## Open Items

- Group calls / voice channels (mesh first, SFU later).
- Video tracks and screen share.
- Persistent call lifecycle (table `calls` with timestamps and reason) - for in-chat call history and synchronized duration across peers.
- TURN credential rotation via HMAC time-limited secrets.
