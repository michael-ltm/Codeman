/**
 * @fileoverview Node WebSocket endpoint (`/ws/fleet/node`) — the wire entrypoint a
 * remote node agent (Task 10) connects to. Unlike every other route in this app it
 * is NOT authenticated by the dashboard's Basic Auth/cookie session; it's
 * authenticated by a per-device Bearer token issued during pairing (Task 4's
 * `DeviceRegistry`). The corresponding bypass lives in
 * `src/web/middleware/auth.ts` (the token is validated here, not there).
 *
 * This module only handles the NODE side of the fleet WS surface (a headless
 * agent reporting sessions/terminal data). The browser-facing remote-terminal WS
 * endpoint is Task 11.
 *
 * Handshake:
 * 1. Host allowlist check (anti DNS-rebinding). No Origin check — node agents
 *    aren't browsers and never send one.
 * 2. `Authorization: Bearer <token>` + `X-Codeman-Device-Id: <deviceId>`, verified
 *    via `DeviceRegistry.authenticate`. Any failure closes 4001 *before* any
 *    message handler is attached — an unauthenticated socket never reaches the
 *    controller.
 * 3. The first frame after a successful auth must be a valid `hello` (parses,
 *    `t === 'hello'`, `protocol === FLEET_PROTOCOL_VERSION`, and
 *    `hello.device.id === deviceId`) within `HELLO_TIMEOUT_MS`, or the socket is
 *    closed 4002.
 * 4. A valid hello hands the raw ws socket to
 *    `FleetCentralController.connectNode(deviceId, socket, hello)` — this socket
 *    instance becomes the device's `NodeSocketLike` for the life of the
 *    connection (it structurally satisfies `send`/`close`/`bufferedAmount`, so no
 *    adapter wrapper is needed).
 * 5. Every subsequent message is parsed with `parseNodeToCentralFrame` and routed
 *    to `controller.handleNodeFrame`; unparseable frames are dropped and counted
 *    — `MAX_CONSECUTIVE_INVALID_FRAMES` in a row closes the socket (1003), since
 *    a stream of garbage past a successful hello indicates a broken/hostile
 *    client rather than transient noise. A single valid frame resets the streak.
 *
 * On `close` (from any state, including pre-hello), this route always calls
 * `controller.disconnectNode(deviceId, socket)` with the SAME socket instance
 * passed to `connectNode`. `disconnectNode` uses reference equality as a
 * staleness guard: if `connectNode` already replaced this device's connection
 * (e.g. a reconnect raced this socket's belated close event), the stale call is
 * a safe no-op rather than tearing down the new connection. See
 * central-controller.ts's `connectNode`/`disconnectNode` docs for the full
 * rationale — this discipline was a explicit handoff requirement from Task 8's
 * review.
 */

import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { FleetCentralController } from '../../fleet/central-controller.js';
import type { DeviceRegistry } from '../../fleet/device-registry.js';
import { FLEET_PROTOCOL_VERSION, parseNodeToCentralFrame } from '../../fleet/protocol.js';
import { isAllowedRequestHost, type HostPolicy } from '../network-auth-policy.js';

/** How long after a successful auth to wait for the first (hello) frame. */
const HELLO_TIMEOUT_MS = 5_000;

/** Consecutive unparseable post-hello frames before the connection is dropped. */
const MAX_CONSECUTIVE_INVALID_FRAMES = 20;

/** How often to ping the node (ms) — mirrors ws-routes.ts's terminal WS cadence. */
const WS_PING_INTERVAL_MS = 30_000;

/** If pong isn't received within this window after a ping, terminate the socket. */
const WS_PONG_TIMEOUT_MS = 10_000;

/** Header carrying the paired device's id (the Bearer token alone doesn't identify it). */
const DEVICE_ID_HEADER = 'x-codeman-device-id';

export function registerFleetWsRoutes(
  app: FastifyInstance,
  deps: {
    controller: FleetCentralController;
    registry: DeviceRegistry;
    getHostPolicy: () => HostPolicy;
    /** Test seam only — production callers should omit this (defaults to HELLO_TIMEOUT_MS). */
    helloTimeoutMs?: number;
  }
): void {
  const { controller, registry, getHostPolicy } = deps;
  const helloTimeoutMs = deps.helloTimeoutMs ?? HELLO_TIMEOUT_MS;

  app.get('/ws/fleet/node', { websocket: true }, (socket: WebSocket, req) => {
    // Anti DNS-rebinding Host allowlist. No Origin check: node agents are
    // headless clients (curl-equivalent) that never send an Origin header, so
    // gating on it would just reject every legitimate connection.
    const policy = getHostPolicy();
    if (!isAllowedRequestHost(req.headers.host, policy)) {
      socket.close(4003, 'Forbidden');
      return;
    }

    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : null;
    const deviceIdHeader = req.headers[DEVICE_ID_HEADER];
    const deviceId = typeof deviceIdHeader === 'string' ? deviceIdHeader : null;

    if (!token || !deviceId || !registry.authenticate(deviceId, token)) {
      // Close before attaching any listener — an unauthorized socket must never
      // reach handleNodeFrame/connectNode.
      socket.close(4001, 'Unauthorized');
      return;
    }

    // Auth passed — deviceId is a validated, non-null string for the rest of this closure.
    socket.on('error', () => {}); // cleanup happens in 'close', same as ws-routes.ts

    let connected = false;
    let invalidFrameStreak = 0;

    const helloTimer = setTimeout(() => {
      socket.close(4002, 'Expected hello');
    }, helloTimeoutMs);

    // Attach the message handler synchronously, before any async work
    // (@fastify/websocket requirement to avoid dropping the first frame).
    socket.on('message', (raw) => {
      const frame = parseNodeToCentralFrame(String(raw));

      if (!connected) {
        if (
          !frame ||
          frame.t !== 'hello' ||
          frame.protocol !== FLEET_PROTOCOL_VERSION ||
          frame.device.id !== deviceId
        ) {
          socket.close(4002, 'Expected hello');
          return;
        }
        clearTimeout(helloTimer);
        connected = true;
        controller.connectNode(deviceId, socket, frame);
        return;
      }

      if (!frame) {
        invalidFrameStreak += 1;
        if (invalidFrameStreak >= MAX_CONSECUTIVE_INVALID_FRAMES) {
          socket.close(1003, 'Too many invalid frames');
        }
        return;
      }
      invalidFrameStreak = 0;
      controller.handleNodeFrame(deviceId, frame);
    });

    // Heartbeat: detect stale connections (mirrors ws-routes.ts's terminal WS —
    // same 30s ping / 10s pong-timeout cadence).
    let pongTimeout: ReturnType<typeof setTimeout> | null = null;
    socket.on('pong', () => {
      if (pongTimeout) {
        clearTimeout(pongTimeout);
        pongTimeout = null;
      }
    });
    const pingInterval = setInterval(() => {
      if (socket.readyState !== 1) return;
      socket.ping();
      pongTimeout = setTimeout(() => socket.terminate(), WS_PONG_TIMEOUT_MS);
    }, WS_PING_INTERVAL_MS);

    socket.on('close', () => {
      clearTimeout(helloTimer);
      clearInterval(pingInterval);
      if (pongTimeout) clearTimeout(pongTimeout);
      // Always the SAME socket instance passed to connectNode — disconnectNode's
      // reference-equality guard makes this safe even if connectNode never ran
      // (handle absent → no-op) or already replaced it (stale close → no-op).
      controller.disconnectNode(deviceId, socket);
    });
  });
}
