# Fleet Dashboard

Operational guide for the Codeman Fleet Dashboard: a central `codeman web`
instance that lists every paired device, aggregates their sessions, and lets
you open/control any device's terminals from one page. Full design rationale
lives in
[`docs/superpowers/specs/2026-07-02-fleet-dashboard-design.md`](superpowers/specs/2026-07-02-fleet-dashboard-design.md)
— this doc covers day-to-day usage, pairing, the smoke test, and
troubleshooting.

## Architecture (short version)

One codebase, two roles, selected purely by whether `fleet-node.json` exists
in the instance's data dir:

- **Central**: a normal `codeman web` whose dashboard shows every paired
  device (including itself, registered as the `local` device) and lets you
  create/attach/split-grid their sessions from `/api/fleet/*` REST + SSE.
- **Node**: a device joined to a central controller. `WebServer.start()`
  detects `fleet-node.json` and starts a `FleetNodeAgent` **in the same
  process** — there is no separate headless daemon. The agent opens an
  outbound WebSocket (`/ws/fleet/node`, `Authorization: Bearer <token>` +
  `X-Codeman-Device-Id`), sends a `hello` frame with its session list, then a
  10s heartbeat. On disconnect it reconnects with exponential backoff
  (1s → 2s → 4s … capped at 30s, reset on a successful connect;
  `src/fleet/node-agent.ts`).

Central talks to every device through one interface,
`FleetDeviceHandle` (`createSession`/`stopSession`/`writeInput`/`resize`/
`subscribeTerminal`/`getTerminalBuffer`): the `local` device is a
`LocalDeviceAdapter` calling straight into the same process's session
manager, a remote device is a `RemoteDeviceHandle` that turns each call into
an RPC frame over the node's WebSocket. The dashboard and REST routes never
special-case local vs. remote.

`codeman node run` is a thin alias for `codeman web --host 127.0.0.1` — it
reuses the exact same server and session stack, just bound to loopback with
the fleet agent active.

## Per-instance isolation (`CODEMAN_INSTANCE`)

Codeman's data dir (`~/.codeman`) and tmux socket (`-L codeman`) are
process-wide and shared by every instance on a machine by default. Setting
`CODEMAN_INSTANCE=<name>` isolates **both** in one variable
(`src/config/instance.ts:36`):

| `CODEMAN_INSTANCE` | Data dir | tmux socket |
|---|---|---|
| unset (default) | `~/.codeman` | `-L codeman` |
| `beta` | `~/.codeman-beta` | `-L codeman-beta` |
| `fleetc` | `~/.codeman-fleetc` | `-L codeman-fleetc` |

Use a distinct `CODEMAN_INSTANCE` per device role when running multiple
Codeman processes on one machine (e.g. local dev, or the smoke test below) so
they never discover each other's tmux sessions or clobber each other's
`state.json`/`fleet-devices.json`. `CODEMAN_DATA_DIR` can override just the
data dir, but since it leaves the tmux socket on the shared default, prefer
`CODEMAN_INSTANCE` whenever you need full isolation — it's also the
established convention in this repo (see `scripts/run-beta.sh`).

## Pairing a device

On the **central** machine (already running `codeman web`), request a
one-time pairing code:

```bash
curl -X POST http://<central-host>:3100/api/fleet/pairing-codes -H 'content-type: application/json' -d '{}'
# → {"success":true,"data":{"code":"8H3BPL4H","expiresAt":...,"joinCommand":"codeman node join http://<central-host>:3100 --code 8H3BPL4H"}}
```

The dashboard UI exposes the same call behind an "Add device" action; the
code is 8 characters (excludes ambiguous `0`/`O`/`1`/`I`), **one-time use**,
and expires after **10 minutes**.

On the **device to add**, run the printed `joinCommand` (or type it
manually):

```bash
codeman node join http://<central-host>:3100 --code 8H3BPL4H --name my-macmini
```

This POSTs to the auth-exempt `/api/fleet/pair` endpoint, receives
`{deviceId, token}`, and writes `~/.codeman/fleet-node.json` (mode `0600`,
token stored locally in plaintext; central only ever stores its SHA-256
hash). Then bring the node online:

```bash
# Either restart the existing web server (it will pick up fleet-node.json), or:
codeman node run
```

`codeman node run` refuses to start (`✗ Not joined to a fleet …`) if
`fleet-node.json` is missing — run `node join` first. It reads its listen
port from `CODEMAN_PORT` (default 3100 — pick something free if you're also
running a normal `codeman web` on the same box) and always binds
`127.0.0.1`.

## End-to-end local smoke test

`scripts/fleet-dev-smoke.sh` boots a central (`CODEMAN_INSTANCE=fleetc`,
`:3100`) and a node (`CODEMAN_INSTANCE=fleetn`, `codeman node run` on
`:3199`) on **the same machine**, pairs them, creates a remote shell session,
sends `echo fleet-ok`, and asserts the string shows up in the central-side
terminal buffer:

```bash
./scripts/fleet-dev-smoke.sh
# ... ends with:
# SMOKE PASS
```

Requirements: tmux installed (`which tmux`), Node/npm, nothing already
listening on `:3100`/`:3199`. No `CODEMAN_PASSWORD` is set — both servers
bind loopback only, and the auth middleware is a no-op unless
`CODEMAN_PASSWORD` is set (`src/web/middleware/auth.ts`), so this is safe for
a throwaway local run but must never be copied verbatim onto a
network-reachable instance.

The script is fully self-contained: it isolates both instances via
`CODEMAN_INSTANCE` (never touches `~/.codeman` or the production `-L codeman`
tmux socket), and its `EXIT` trap kills both server processes and their
process groups, tears down the two per-run tmux socket servers
(`tmux -L codeman-fleetc kill-server`, `tmux -L codeman-fleetn kill-server`),
and removes `~/.codeman-fleetc`/`~/.codeman-fleetn` — verified by inspecting
`ps`/`lsof`/`tmux ls` after a run leaves none of the smoke test's processes,
listening ports, or tmux sessions behind. It polls each readiness condition
(server up, device online, buffer contains the echo) instead of sleeping a
fixed amount, with a 10s ceiling per step, so it's less timing-sensitive than
a bare `sleep`-based script — see the script's comments for the one
remaining fixed `sleep 2` (giving the freshly-created shell PTY a moment to
spawn before the first input write), which is deliberate rather than a
leftover.

The unit/integration test suite (`npm test`) already exercises the
individual pieces this script chains together (pairing, node WS
protocol, REST routes, browser terminal WS) in isolation and remains the
authoritative correctness check; this script's value is validating the
whole chain wires together on a real machine with real tmux and real
processes.

## Troubleshooting

**tmux missing** — tmux is a hard requirement for the whole server, not just
fleet mode: `createMultiplexer()` (`src/mux-factory.ts`) checks
`TmuxManager.isTmuxAvailable()` at boot and, if it's missing, `codeman web` /
`codeman node run` refuses to start at all —
`✗ Failed to start web server: tmux not found. Install: sudo apt install tmux`
(verified by running with tmux stripped from `PATH`). So a node that's
reachable/online always has a working tmux by construction; if a device
won't come online, check `codeman doctor` (or `which tmux`) on that machine
and install tmux (`brew install tmux` / `apt install tmux`) before retrying
`codeman node run`.

**409 "Device is offline"** — returned by `POST/DELETE
/api/fleet/devices/:deviceId/sessions*` when the target device has no live
WebSocket connection to central (`FleetCentralController.isOnline`). Causes:
the node process isn't running, it's mid-reconnect (up to 30s backoff after
a drop), or it was joined but never started with `codeman node run` /
restarted `codeman web`. Check the node's own logs; once its `hello` frame
lands, the dashboard flips the device to online within seconds via SSE
(`fleet:device-online`).

**400 "Pairing code invalid or expired"** — the one-time code was already
consumed (each call to `node join` burns it, success or failure), or more
than 10 minutes passed since `POST /api/fleet/pairing-codes`. Generate a
fresh code and re-run `codeman node join`.
