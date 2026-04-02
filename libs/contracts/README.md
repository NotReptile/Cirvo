# Contracts

This directory stores transport-level contracts shared across services and the desktop client.

## Layout

- `http/openapi.yaml` - initial HTTP surface.
- `realtime/events.json` - transport events for presence and signaling.
- `errors/error-model.json` - shared error envelope.

The contracts are intentionally minimal in the first iteration. They define boundaries without forcing full feature implementation.
