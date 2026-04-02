# Client Architecture

## Layers

- `ui` - shell rendering and view composition.
- `application` - orchestration and use-case entrypoints.
- `network` - HTTP transport adapters.
- `realtime` - websocket transport adapter.
- `media` - reserved integration point for microphone, camera and screen share.
- `local-cache` - settings and client-only cached state.

## Rules

- UI does not make raw transport calls directly.
- client cache improves responsiveness but does not replace server authority.
- media logic remains isolated from UI composition to keep future WebRTC work contained.
