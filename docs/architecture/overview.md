# Architecture Overview

## Goal

RuCord is a modular communication platform with a Tauri desktop client and a Go backend. The first iteration optimizes for clear boundaries, portability and a viable MVP instead of early microservice expansion.

## Runtime Units

- `apps/desktop` - desktop client shell on Tauri and TypeScript.
- `services/core-api` - main API process with internal domain modules.
- `services/realtime` - transport, presence and signaling process.
- `services/worker` - background jobs for media processing, notifications and audit fan-out.
- `db` - relational schema and migrations. The first admin user and default workspace are not seeded as SQL; `core-api` provisions them from `RUCORD_BOOTSTRAP_*` env on the first startup against an empty DB.

## Boundary Rules

- `core-api` is the source of truth for core domain state.
- `realtime` only transports short-lived events and presence data.
- Redis and broker support transient coordination, not canonical domain storage.
- object storage is reserved for file and media payloads.
- media routing, SFU and TURN remain explicit future boundaries from day one.
