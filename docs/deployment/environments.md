# Environments

Deployment profile and runtime stage are separate concerns. A profile describes topology, while a stage describes operational strictness such as `dev`, `test` or `prod`.

## Local

- developer workstation;
- minimal dependencies;
- first admin provisioned via `RUCORD_BOOTSTRAP_*` env at startup, or self-register via `/auth/register`;
- relaxed domain and TLS assumptions.

## Single-Node

- one host with all runtime units;
- reverse proxy and TLS may be colocated;
- suitable for small self-hosted deployments.

## Internet-Facing

- public DNS and TLS required;
- API and realtime endpoints published explicitly;
- TURN and firewall posture must be documented before production use.
