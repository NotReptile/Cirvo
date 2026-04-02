# Security Overview

## Rules

- server-authoritative permission checks;
- externalized secrets and environment settings;
- hashed password storage only;
- structured audit for critical actions;
- TLS for public API and realtime endpoints.

## First Iteration Notes

- local bootstrap credentials are placeholders and must be rotated;
- session revocation lives in the relational source of truth;
- public deployment must include reverse proxy, TLS termination and TURN planning.
