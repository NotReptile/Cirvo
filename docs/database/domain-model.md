# Domain Model

## First Iteration Entities

- `users`
- `user_sessions`
- `workspaces`
- `workspace_members`
- `channels`
- `messages`
- `workspace_invites`
- `upload_sessions`
- `audit_log`

## Principles

- PostgreSQL is the source of truth for core domain entities.
- Redis is reserved for short-lived coordination and presence state.
- broker events are transport artifacts, not domain ownership.
- files and media payloads belong to object storage, while relational data stores only metadata.
