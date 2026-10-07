# ADR: Media Boundary

## Status

Accepted

## Decision

Keep signaling, session orchestration and media transport as separate concerns from the start.

## Rationale

- realtime transport can evolve independently from media routing;
- SFU and TURN integration stays outside `core-api` (implemented, see [ADR: SFU Media Path](adr-sfu-media-path.md));
- the API owns metadata and policy, not raw media flow.
