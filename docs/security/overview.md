# Security Overview

## Rules

- server-authoritative permission checks;
- channel visibility uses the shared batched ACL for HTTP, live events, journal replay, typing and SFU admission; active SFU connections are rechecked every five seconds. The detailed contract is [permissions.md](../api/permissions.md).
- externalized secrets and environment settings;
- hashed password storage only;
- structured audit for critical actions;
- TLS for public API and realtime endpoints.

## First Iteration Notes

- the first admin is provisioned at process start from `CIRVO_BOOTSTRAP_*` env into a fresh database; there are no SQL-seeded placeholder credentials anymore;
- session revocation lives in the relational source of truth;
- public deployment must include reverse proxy, TLS termination and TURN planning.
