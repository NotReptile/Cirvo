# Internet-Facing Runbook

`deploy/single-node/docker-compose.yml` — единственный актуальный production
manifest. `deploy/internet-facing/compose.yaml` оставлен только как исторический
черновик и не должен использоваться для запуска RuCord.

## Preconditions

- public DNS;
- TLS certificates;
- explicit API and realtime publication;
- firewall/NAT rules for `80/tcp`, `443/tcp`, `3478/tcp+udp`,
  `49160-49200/udp` (TURN relay) and `50000/udp` (SFU RTP).

## Flow

1. Configure one public DNS name and a valid TLS email in `deploy/.env`.
2. Set TURN URL list/shared secret and the public SFU IP.
3. Apply migrations, including `000040_realtime_events`.
4. Start `deploy/single-node/docker-compose.yml`; SFU and coturn start by default.
5. Verify `/readyz`, `/ws`, `/sfu/ws`, TURN relay allocation and RTP bytes.
