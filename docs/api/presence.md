# Presence and manual status

`PUT /api/v1/users/me/status` accepts `mode` (`online`, `idle`, `dnd`, `invisible`) and `customStatus`. The response is the authoritative self profile, including the actual `updatedAt` version stored in `users`. Manual status remains independent of socket connectivity: a connected user who selected idle or DND keeps that mode.

Automatic idle transitions additionally send both `expectedMode` and `expectedUpdatedAt`. The update applies only if both still match the stored profile. A stale transition returns HTTP 200 with the current self profile, without an audit entry or presence event. Supplying only one precondition is invalid. This prevents delayed automatic activity requests from replacing a later manual choice, including a manual choice of idle.

Public `presence.updated` payloads contain `userId`, effective `mode`, `customStatus`, and `updatedAt`. Effective mode is offline when no active session remains. Invisible is always exposed as offline with an empty custom status. Workspace members, DM peers, and accepted friends receive updates. The private `presence.self.updated` event targets only the owning user and contains the actual manual mode/custom status plus the initiating `sessionId`, allowing other sessions to synchronize without revealing invisible status to peers.

Realtime connect/disconnect updates aggregate all sockets for the user. Disconnecting one session leaves other active sessions online; cleanup of a replaced socket cannot remove its replacement. Lifecycle operations serialize per user, never across all users. `presence.snapshot` retains `workspaces` and adds `users` with the same public fields, providing fresh state on connection and subscription refresh. Existing clients may ignore the additive field.

The desktop uses one presence resolver for member lists, DM/friend views, profiles, and voice tiles. Explicit modes take precedence over the legacy `online` flag. Self uses the authoritative self profile; peer HTTP snapshots cannot overwrite a newer realtime update. Presence-only renders preserve the composer, message scroll, and video nodes.
