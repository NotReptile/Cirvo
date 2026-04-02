# Monorepo Structure

## Root Layout

- `apps` - user-facing applications.
- `services` - deployable backend processes.
- `db` - relational model artifacts.
- `libs` - shared code and contracts.
- `deploy` - environment-specific deployment assets.
- `docs` - technical wiki and ADRs.

## Why Monorepo

- contracts, docs and code evolve together;
- environment and deployment assets stay versioned with services;
- changes across desktop, backend and migrations can be reviewed in one place;
- the first iteration remains simple without cross-repository coordination overhead.
