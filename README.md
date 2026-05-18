# RuCord

RuCord is a modular communication platform with a desktop client and a Go backend.

## Repository Layout

- `apps/desktop` - Tauri desktop client on TypeScript.
- `services/core-api` - main Go API with internal domain modules.
- `services/realtime` - transport, presence and signaling node.
- `services/worker` - background jobs.
- `db` - schema and migrations (first admin is provisioned from env on first start).
- `libs/contracts` - transport and event contracts.
- `libs/shared-go` - reusable Go infrastructure packages.
- `libs/shared-ts` - reusable TypeScript primitives.
- `deploy` - local, single-node and internet-facing deployment assets.
- `docs` - technical documentation and ADRs.

## Principles

- monorepo with explicit boundaries;
- server-authoritative domain model;
- realtime is not a source of truth;
- configuration is externalized for each environment;
- local, single-node and internet-facing modes share one architecture.

## Quick Start

See `docs/README.md` for the technical wiki entrypoint.
