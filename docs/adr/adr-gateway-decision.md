# ADR: Gateway Decision

## Status

Accepted

## Decision

Treat gateway behavior as a logical edge role inside `core-api` in the first iteration instead of a dedicated process.

## Rationale

- keeps the initial topology simple;
- preserves a future extraction path;
- avoids premature process fragmentation while retaining boundary awareness.
