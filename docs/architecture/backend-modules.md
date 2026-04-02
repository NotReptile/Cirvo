# Backend Modules

## `core-api`

`services/core-api` is a single deployable unit in the first iteration, but its internals are split into logical modules:

- `auth`
- `profile`
- `workspace`
- `permission`
- `channel`
- `message`
- `attachment`
- `audit`
- `system`

## Dependency Rules

- transport handlers call application entrypoints only;
- domain modules do not read another module's tables directly without a contract;
- external systems are reached through infrastructure adapters;
- gateway concerns are treated as an edge role inside `core-api` in the first iteration.

## `realtime`

`services/realtime` owns:

- websocket transport;
- presence snapshots and updates;
- signaling transport for calls.

It does not own canonical message, workspace, membership or permission state.
