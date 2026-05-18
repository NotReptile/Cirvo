# Security Overview

## Rules

- server-authoritative permission checks;
- externalized secrets and environment settings;
- hashed password storage only;
- structured audit for critical actions;
- TLS for public API and realtime endpoints.

## First Iteration Notes

- the first admin is provisioned at process start from `RUCORD_BOOTSTRAP_*` env into a fresh database; there are no SQL-seeded placeholder credentials anymore;
- session revocation lives in the relational source of truth;
- public deployment must include reverse proxy, TLS termination and TURN planning.
