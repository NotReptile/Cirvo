# Database Schema

The relational database is the source of truth for core domain data.

## Scope of the first iteration

- users and sessions;
- workspaces, membership and invites;
- channels and messages;
- upload metadata;
- audit records.

Schema changes must be implemented through `db/migrations` and documented in `docs/database/migrations-strategy.md`.
