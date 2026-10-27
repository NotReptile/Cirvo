# Migrations Strategy

## Rules

- schema changes are applied only through numbered SQL migrations in `db/migrations`;
- every migration must have `up` and `down` files;
- production-safe migrations must be additive first whenever possible;
- the first owner user and default workspace are not seeded as SQL - `core-api` provisions them on startup from `CIRVO_BOOTSTRAP_*` env when the `users` table is empty (see `internal/bootstrap`).

## First Iteration Workflow

1. Apply `db/migrations` in order.
2. On first start `core-api` reads `CIRVO_BOOTSTRAP_EMAIL` / `_USERNAME` / `_PASSWORD` (optional `_DISPLAY_NAME`, `_WORKSPACE_SLUG`, `_WORKSPACE_NAME`) and creates the first owner + default workspace + `#general` channel in one transaction. If the env is not set the operator must self-register via `POST /api/v1/auth/register`.
3. Keep breaking data rewrites out of request handlers and background them when needed.
