# Internet-Facing Runbook

## Preconditions

- public DNS;
- TLS certificates;
- explicit API and realtime publication;
- firewall rules for HTTP, HTTPS and planned TURN traffic.

## Flow

1. Start infrastructure from `deploy/internet-facing`.
2. Configure public DNS and reverse proxy.
3. Run migrations before exposing new application versions.
4. Verify health endpoints and websocket reachability.
