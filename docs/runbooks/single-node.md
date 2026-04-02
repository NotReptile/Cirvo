# Single-Node Runbook

## Goal

Run all infrastructure and application units on one host while keeping module boundaries intact.

## Flow

1. Start infrastructure from `deploy/single-node`.
2. Run database migrations.
3. Start `core-api`, `realtime` and `worker` as separate processes or containers.
4. Route HTTP and websocket traffic through the provided reverse proxy.
