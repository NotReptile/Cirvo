# Backend Modules

## `core-api`

`services/core-api` is a single deployable unit in the first iteration, but its internals are split into logical modules:

- `auth`
- `profile`
- `workspace`
- `permission` - role-based access matrix; single source of truth for "who can do what".
- `channel`
- `message`
- `attachment`
- `audit`
- `ice` - serves WebRTC ICE server configuration to the client.
- `system`

## Dependency Rules

- transport handlers call application entrypoints only;
- domain modules do not read another module's tables directly without a contract;
- external systems are reached through infrastructure adapters;
- gateway concerns are treated as an edge role inside `core-api` in the first iteration.

## Permission Module

`modules/permission` owns the role-to-actions matrix. Modules never compare role strings inline; they call `permission.Authorize(ctx, db, workspaceID, userID, action)` or, when the role is already in hand, `permission.Can(role, action)`.

- `Action` is a semantic constant (`permission.ChannelCreate`, `permission.MessageModerate`, ...). New permissions live here, not as new `if role == "..."` branches inside handlers.
- `Authorize` returns `(role, isMember, allowed)` so callers can distinguish 404 ("not a member - hide the workspace's existence") from 403 ("member but no permission").
- The matrix grants `owner` and `admin` everything; `moderator` gets content moderation + invites + audit + kick; `member` gets nothing extra. Owner-only actions (transfer ownership, delete workspace) will be modeled as separate Actions when they appear.
- To avoid an import cycle with `workspace` (which itself calls `permission.Authorize`), role codes are duplicated as unexported constants in `permission`. The canonical source remains `workspace.RoleOwner` / `RoleAdmin` / `RoleModerator` / `RoleMember`.

## `realtime`

`services/realtime` owns:

- websocket transport;
- presence snapshots and updates;
- signaling transport for calls.

It does not own canonical message, workspace, membership or permission state.

## `worker`

`services/worker` runs background jobs out of the `media_jobs` table.

- Polls with `update ... where id = (select ... for update skip locked limit 1) returning ...` so multiple replicas don't double-process.
- Retries with exponential backoff up to 3 attempts; terminal failures land in `status = 'failed'` with `last_error`.
- Handlers are registered in `jobs.Runner` keyed by `kind`. Adding a new job type means:
  1. add a job kind constant and handler implementing `jobs.Handler`;
  2. register it in `NewRunner`;
  3. schedule rows in `media_jobs` from the place that produces the work.

Implemented kinds:

- `thumbnail` - fetches the source image from MinIO, resizes to 512 px on the longest side (`golang.org/x/image/draw` BiLinear), encodes as JPEG q80, writes `<key>.thumb.jpg` back to the bucket and updates `media_objects.thumbnail_object_key / thumbnail_width / thumbnail_height`. Triggered from `attachment.handleUpload` when the uploaded `content_type` matches `image/{jpeg,png,gif,webp}`.

Client consumes thumbnails via `GET /api/v1/media/{id}/thumb`. The endpoint falls back to the original object if the thumbnail has not been generated yet, so UI never breaks while a job is in flight.

Future job kinds (planned): notifications, audit fan-out.
