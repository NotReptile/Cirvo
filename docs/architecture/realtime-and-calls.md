# Realtime And Calls

## Realtime Scope

The realtime node is limited to:

- transport connection lifecycle;
- presence events;
- signaling message transport.

It is not responsible for canonical message persistence, workspace membership or role evaluation.

## Call Boundary

The first iteration reserves the media architecture instead of fully implementing it:

- signaling travels through `services/realtime`;
- call session authority remains a backend concern;
- SFU and TURN are planned infrastructure dependencies;
- media streams stay outside the main API domain model except for metadata and orchestration hooks.
