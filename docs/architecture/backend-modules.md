# Backend Modules

## `core-api`

`services/core-api` is a single deployable unit in the first iteration, but its internals are split into logical modules:

- `auth`
- `profile`
- `workspace`
- `permission`
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
