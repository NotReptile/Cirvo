# Client Architecture

## Layers

- `ui` (`apps/desktop/src/app/`) - shell rendering and view composition.
- `application` (`apps/desktop/src/app/bootstrap.ts`) - orchestration and use-case entrypoints.
- `network` (`apps/desktop/src/network/`) - HTTP transport adapter.
- `realtime` (`apps/desktop/src/realtime/`) - WebSocket transport adapter (`send`/`subscribe`).
- `call` (`apps/desktop/src/call/`) - WebRTC call state machine; consumes `realtime` for signaling and `network` for ICE config.
- `local-cache` - settings and client-only cached state (currently `localStorage` for tokens, in-memory blob cache for media previews).

## Rules

- UI does not make raw transport calls directly. UI talks to managers (`HttpClient`, `RealtimeClient`, `CallManager`).
- Client cache improves responsiveness but does not replace server authority.
- Media logic stays in `call/` and exposes a state-machine snapshot to UI - UI never touches `RTCPeerConnection` or `MediaStream` directly.

## Cross-Platform Rule

Target platforms are **desktop + web + Android** via Tauri 2 (Android stable since 2.x). The current client is plain TypeScript + CSS inside a webview and contains no platform-specific calls. This is a deliberate constraint:

- Do not import `@tauri-apps/api/*` from anywhere inside `apps/desktop/src/`.
- If a feature genuinely needs platform-specific APIs (native notifications, deep links, native file picker, push), introduce a thin adapter module with a web fallback and inject it at `bootstrap.ts` - never inside business logic.
- The same bundle must be deployable as PWA (web), Tauri desktop (Windows/Mac/Linux) and Tauri mobile (Android) without source forks.

Concretely this affects: storage (use `localStorage` / `IndexedDB`, not native FS), notifications (use `Notification` API with permission prompt, not native), file picking (use `<input type=file>`).
