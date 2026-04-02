# Local Development

## Required Services

- PostgreSQL
- Redis
- object storage compatible endpoint
- broker placeholder or future event bus
- `core-api`
- `realtime`
- `worker`
- `apps/desktop`

## Initial Flow

1. Start infrastructure from `deploy/local`.
2. Apply migrations from `db/migrations`.
3. Apply bootstrap seed from `db/seed/local.bootstrap.sql`.
4. Start `core-api`, `realtime` and `worker`.
5. Start the desktop app.
