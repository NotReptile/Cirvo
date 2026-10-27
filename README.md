# Cirvo

Self-hosted chat and voice for small communities: your own Discord-like server that you run yourself.

[Русский](README.ru.md)

[![smoke](https://github.com/NotReptile/Cirvo/actions/workflows/smoke.yml/badge.svg)](https://github.com/NotReptile/Cirvo/actions/workflows/smoke.yml)
[![desktop-check](https://github.com/NotReptile/Cirvo/actions/workflows/desktop-check.yml/badge.svg)](https://github.com/NotReptile/Cirvo/actions/workflows/desktop-check.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Cirvo is built for friend groups and small to medium communities (tens to hundreds of users per instance). One instance is one server; several workspaces are possible inside it. The server runs on Linux in Docker, and the main client is a Tauri desktop app for Windows.

> **Status: early version.** The Windows client and the server stack are released as an early version. Web and Android clients are planned, not available yet. For the current version and what changed, see [CHANGELOG.md](CHANGELOG.md).

## Features

- Workspaces with text channels, categories, attachments and reactions
- Threads and forum channels
- Direct messages and friends
- Voice channels and video calls (mesh for small calls, SFU for groups), screen sharing, noise suppression
- Roles and permissions (RBAC) with per-channel access
- Invitations with expiry, and admin-created users with a forced password change
- Presence and statuses, profiles, notifications
- Message search and link previews
- Audit log and an admin panel (registration, attachment size, storage quota)
- Windows desktop client with signed auto-updates
- No external services required for voice: STUN/TURN is provided by your own coturn

## Architecture

| Component | Description | Port |
| --- | --- | --- |
| `apps/desktop` | Client: TypeScript, Vite, Tauri 2 | dev server 1420 |
| `services/core-api` | Go HTTP API | 8080 |
| `services/realtime` | Go WebSocket: presence, signaling, event journal | 8090 |
| `services/sfu` | Go SFU (pion) for group voice and video | 8095, media on UDP 50000 |
| `services/worker` | Go background jobs: previews, retention, notifications | - |

Infrastructure: Postgres, Redis, MinIO (object storage), coturn (TURN, port 3478) and Caddy (TLS and reverse proxy).

```
                  +-----------+
  Desktop client  |   Caddy   |  TLS, reverse proxy
  --------------> | 80 / 443  |
                  +-----+-----+
                        | HTTP / WebSocket
        +---------------+---------------+
        |               |               |
   core-api :8080  realtime :8090   sfu :8095  (media: UDP 50000)
        |               |               |
        +------+--------+---------------+
               |
     Postgres, Redis, MinIO        coturn :3478 (TURN)

   worker: background jobs (previews, retention, notifications)
```

## Quick start

### Run your own server

Requirements: Docker with `docker compose`.

```bash
cp deploy/.env.example deploy/.env
# edit deploy/.env: secrets, domain, CORS origins, SFU public IP, TURN

docker compose -f deploy/single-node/docker-compose.yml --env-file deploy/.env run --rm migrate
docker compose -f deploy/single-node/docker-compose.yml --env-file deploy/.env up -d
```

Before the first start you must change at least `CIRVO_JWT_SECRET` (at least 32 bytes), `POSTGRES_PASSWORD`, `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`, the `CIRVO_BOOTSTRAP_*` values (first administrator), `CIRVO_DOMAIN` (for example `chat.example.com`), `CIRVO_CORS_ORIGINS` (no `*`; for the Windows client it must include `tauri://localhost,http://tauri.localhost,https://tauri.localhost`), `CIRVO_SFU_PUBLIC_IP` (`<PUBLIC_IP>`) and the TURN settings (`ICE_TURN_URLS`, `ICE_TURN_SHARED_SECRET`).

Ports to open: `80/tcp`, `443/tcp`, `3478/tcp+udp`, `49160-49200/udp` and `50000/udp`.

Full guide: [docs/runbooks/single-node.md](docs/runbooks/single-node.md) (in Russian).

### Develop locally

Requirements: Docker, Go 1.26+, Node.js 20.19+ or 22.12+ (CI uses Node 22). Building the desktop executable also needs Rust (stable) and MSVC Build Tools.

```bash
cp deploy/.env.example deploy/.env
# for local mode set CIRVO_SFU_URL= (empty); export the variables from deploy/.env into your shell

docker compose --env-file deploy/.env -f deploy/local/docker-compose.yml up -d postgres redis minio
docker compose --env-file deploy/.env -f deploy/local/docker-compose.yml run --rm migrate

# each in its own terminal, with the environment exported
go run github.com/NotReptile/Cirvo/services/core-api/cmd/core-api
go run github.com/NotReptile/Cirvo/services/realtime/cmd/realtime
go run github.com/NotReptile/Cirvo/services/worker/cmd/worker

# client
npm ci
npm run dev:desktop      # Vite dev server on http://127.0.0.1:1420
```

Details: [docs/runbooks/local-development.md](docs/runbooks/local-development.md) (in Russian).

## Desktop client

The client targets Windows 10/11 (64-bit). Download the installer `Cirvo_<version>_x64-setup.exe` from [GitHub Releases](https://github.com/NotReptile/Cirvo/releases), run it and enter your server address (for example `chat.example.com`). The installer is not Authenticode-signed yet, so Windows SmartScreen shows a warning: choose "More info" and then "Run anyway". Updates are verified with a separate signature key. See [docs/runbooks/windows-client.md](docs/runbooks/windows-client.md) and [docs/runbooks/desktop-release.md](docs/runbooks/desktop-release.md).

Build from source:

```bash
npm ci
npm run build:desktop                           # web bundle
npm --workspace apps/desktop run tauri build    # Windows exe; needs Rust and a signing key
```

## Repository layout

| Path | Contents |
| --- | --- |
| `apps/desktop` | Desktop client (TypeScript, Vite, Tauri 2; `src-tauri` is the Rust shell) |
| `services/core-api` | HTTP API; modules in `internal/modules/*` |
| `services/realtime` | WebSocket service |
| `services/sfu` | SFU for group voice and video |
| `services/worker` | Background jobs |
| `libs/shared-go` | Shared Go packages (config, jwtauth, ratelimit, retention, wsticket, ...) |
| `libs/shared-ts`, `libs/contracts` | Shared TypeScript types and contracts |
| `db/migrations` | Numbered golang-migrate migrations (`up` and `down`) |
| `deploy/` | `local/` (development) and `single-node/` (production) |
| `docs/` | Documentation |

## Documentation

Start at [docs/README.md](docs/README.md). The detailed documentation is currently in Russian.

## Contributing

1. Fork the repository and create a branch from `main`.
2. Make your change. Keep new code consistent with the surrounding style (see `.editorconfig`).
3. Before opening a pull request, run:

   ```bash
   npm ci
   npm run check:desktop
   npm --workspace apps/desktop test
   go build ./libs/shared-go/... ./services/core-api/... ./services/realtime/... ./services/sfu/... ./services/worker/...
   go test -race ./libs/shared-go/... ./services/core-api/... ./services/realtime/... ./services/sfu/...
   ```

4. Open a pull request against `main`.

Rules:

- Commit messages may be in any language; conventional commits style (`feat(scope): ...`, `fix(scope): ...`) is preferred.
- A new permission is a new `permission.Action` constant plus an entry in the permission matrix. No `if role == "..."` checks in handlers.
- Database migrations are added only as a new file with the next number and an `up`/`down` pair. Do not edit old migrations.
- Never commit secrets (`deploy/.env`, tokens, keys, passwords).

## Security

Please report vulnerabilities privately. See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) (c) 2026 NotReptile
