# ADR: Repository Structure

## Status

Accepted

## Decision

Use a monorepo with top-level `apps`, `services`, `db`, `libs`, `deploy` and `docs`.

## Rationale

- architectural contracts and docs evolve with code;
- migrations and deployment assets remain coupled to runtime changes;
- early-stage coordination is simpler than multi-repo splits.
