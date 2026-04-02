# Migrations Strategy

## Rules

- schema changes are applied only through numbered SQL migrations in `db/migrations`;
- every migration must have `up` and `down` files;
- bootstrap data belongs to `db/seed`;
- production-safe migrations must be additive first whenever possible.

## First Iteration Workflow

1. Apply `db/migrations` in order.
2. Initialize local bootstrap data from `db/seed/local.bootstrap.sql`.
3. Keep breaking data rewrites out of request handlers and background them when needed.
