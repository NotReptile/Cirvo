# Contracts

This directory stores transport-level contracts shared across services and the desktop client.

## Layout

- `http/openapi.yaml` - начальный набросок HTTP API; **неполный**, источник истины - код `core-api` (см. [API overview](../../docs/api/overview.md)).
- `realtime/events.json` - transport events for presence and signaling.
- `errors/error-model.json` - shared error envelope.

The contracts are intentionally minimal in the first iteration. They define boundaries without forcing full feature implementation.
