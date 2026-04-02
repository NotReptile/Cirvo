# ADR: Media Boundary

## Status

Accepted

## Decision

Keep signaling, session orchestration and media transport as separate concerns from the start.

## Rationale

- realtime transport can evolve independently from media routing;
- future SFU and TURN integration stays outside `core-api`;
- the API owns metadata and policy, not raw media flow.
