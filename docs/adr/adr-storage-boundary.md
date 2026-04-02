# ADR: Storage Boundary

## Status

Accepted

## Decision

Use relational storage for canonical domain records, Redis for short-lived state, broker for event transport and object storage for binary payloads.

## Rationale

- each storage type has one clear responsibility;
- short-lived transport state does not leak into domain authority;
- large file payloads do not pollute relational storage.
