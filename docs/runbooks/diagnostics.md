# Diagnostics

## First Checks

- `GET /healthz` on `core-api` and `realtime`;
- `GET /readyz` on `core-api`;
- database connectivity;
- Redis availability;
- reverse proxy reachability.

## Common Failure Groups

- auth failures;
- websocket connection failures;
- migration drift;
- missing object storage configuration;
- event transport or broker outages.
