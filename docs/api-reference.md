# HTTP API Reference

Codeman's HTTP API is a **stable contract** as of 1.0 — see
[`versioning-policy.md`](versioning-policy.md) for the SemVer guarantee. This page
defines the response envelope, status codes, error codes, versioning, and the SSE
event channel.

## Versioning

- The stable, public surface is served under **`/api/v1/...`**. Pin external
  clients to this prefix.
- The unversioned **`/api/...`** paths are a permanent alias of the current
  version (what the bundled web UI uses). They are kept working, but new external
  integrations should use `/api/v1`.
- Breaking changes to the contract ship under a new prefix (`/api/v2`); `/api/v1`
  keeps its semantics. Additive changes (new endpoints, new optional fields, new
  error codes) are non-breaking and may appear in a minor release.
- The implementation rewrites `/api/v1/*` → `/api/*` at the server level
  (`rewriteApiV1Url` in `src/web/server.ts`).

## Response envelope

Every JSON response uses one uniform envelope, applied centrally by a
`preSerialization` hook (`src/web/server.ts`) — handlers return bare data and the
hook wraps it:

**Success** — HTTP `2xx`:

```json
{ "success": true, "data": <payload> }
```

`data` is the endpoint's payload (object, array, or value). Endpoints with no
payload return `{ "success": true, "data": {} }`.

**Error** — HTTP `4xx`/`5xx`:

```json
{ "success": false, "error": "human-readable message", "errorCode": "NOT_FOUND" }
```

`ApiResponse<T>` in `src/types/api.ts` is the canonical type.

> Non-JSON endpoints are exempt from the envelope: `GET /api/sessions/:id/file-raw`,
> `GET /api/sessions/:id/tail-file` (SSE), `GET /api/download`,
> `GET /api/screenshots/:name`, `GET /q/:code` (QR redirect), and the
> `GET /ws/sessions/:id/terminal` WebSocket upgrade.

## Error codes → HTTP status

The single source of truth is `ErrorStatus` / `httpStatusForErrorCode()` in
`src/types/api.ts`. Clients should branch on `errorCode` (stable) and may rely on
the HTTP status.

| `errorCode` | HTTP | Meaning |
|-------------|------|---------|
| `INVALID_INPUT` | 400 | Malformed request / failed validation |
| `UNAUTHORIZED` | 401 | Authentication required or failed |
| `NOT_FOUND` | 404 | Resource does not exist |
| `SESSION_BUSY` | 409 | Session is busy |
| `CONFLICT` | 409 | Conflicts with current state (e.g. already running) |
| `ALREADY_EXISTS` | 409 | Resource already exists |
| `OPERATION_FAILED` | 422 | Well-formed but could not be completed |
| `RATE_LIMITED` | 429 | Too many requests |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

Adding a new error code is non-breaking; removing or renaming one is a major change.

## Authentication

Optional HTTP Basic (`CODEMAN_USERNAME`/`CODEMAN_PASSWORD`) → opaque
`codeman_session` cookie. When enabled, unauthenticated requests get
`401 UNAUTHORIZED`; rate-limited requests get `429 RATE_LIMITED`. See
[`security-architecture.md`](security-architecture.md).

## SSE event channel

`GET /api/events` is a Server-Sent Events stream (`text/event-stream`); each
message is `event: <name>` + `data: <json>`. The event-name registry
(`src/web/sse-events.ts`, mirrored in `src/web/public/constants.js`) is part of
the stable contract — event names are not renamed without a major bump. An
optional `?sessions=<id,...>` filter suppresses only the high-volume terminal
stream; lifecycle/metadata events are delivered to all clients regardless.

## Consuming from JavaScript

The bundled frontend reads responses through `_apiJson()`
(`src/web/public/api-client.js`), which unwraps `{success:true,data}` → `data` and
returns `null` on a non-2xx / `{success:false}` response. External clients should
do the same: check the HTTP status (or `body.success`), then read `body.data`.
