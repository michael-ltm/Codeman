/**
 * @fileoverview Node WebSocket endpoint (`/ws/fleet/node`) — the wire entrypoint a
 * remote node agent (Task 10) connects to. Unlike every other route in this app it
 * is NOT authenticated by the dashboard's Basic Auth/cookie session; it's
 * authenticated by a per-device Bearer token issued during pairing (Task 4's
 * `DeviceRegistry`). The corresponding bypass lives in
 * `src/web/middleware/auth.ts` (the token is validated here, not there).
 *
 * This module also owns the BROWSER side of the fleet WS surface: the
 * remote-terminal proxy at `/ws/fleet/devices/:deviceId/sessions/:sessionId/terminal`
 * (Task 11). Unlike the node endpoint above, this one IS authenticated by the
 * dashboard's normal session (Basic Auth/cookie, checked by the global auth
 * middleware before the request ever reaches here) and additionally checks
 * Origin (see that route's own doc comment below for why).
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
import type { TerminalSink } from '../../fleet/local-session-ops.js';
import { FLEET_PROTOCOL_VERSION, parseNodeToCentralFrame } from '../../fleet/protocol.js';
import { MAX_INPUT_LENGTH } from '../../config/terminal-limits.js';
import { isAllowedRequestHost, isAllowedRequestOrigin, type HostPolicy } from '../network-auth-policy.js';

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

/**
 * Micro-batch interval/flush-threshold and DEC 2026 sync markers for the browser
 * terminal endpoint's 'o' frames — deliberately duplicated from ws-routes.ts
 * (WS_BATCH_INTERVAL_MS/WS_BATCH_FLUSH_THRESHOLD/DEC_2026_START/DEC_2026_END)
 * rather than factored into a shared helper. The two call sites read from
 * different sources (a Session's EventEmitter vs. a FleetDeviceHandle's
 * TerminalSink callback) and this block is ~15 lines with no independent
 * behavior of its own — extracting it would trade a few duplicated constants
 * for an extra indirection layer between two files that otherwise don't share
 * any code. Keep both copies in sync if the batching strategy ever changes.
 */
const TERM_WS_BATCH_INTERVAL_MS = 8;
const TERM_WS_BATCH_FLUSH_THRESHOLD = 16384;
const TERM_DEC_2026_START = '\x1b[?2026h';
const TERM_DEC_2026_END = '\x1b[?2026l';

/** Max concurrent browser terminal WS connections per source IP (not per session/device —
 *  a dashboard viewing several split panes still shares one IP). Prevents a single
 *  runaway client from multiplying listeners/bandwidth across the whole fleet. */
const MAX_TERMINAL_WS_PER_IP = 6;

/** Tracks active browser terminal WS connections per source IP for the cap above. */
const terminalWsCountByIp = new Map<string, number>();

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

  /**
   * Browser-facing remote terminal proxy. Frame protocol is byte-for-byte the
   * same as the local terminal WS (ws-routes.ts): in `{t:'i',d,seq,cid}` /
   * `{t:'z',c,r,f,v}`; out `{t:'o',d}` / `{t:'c'}` / `{t:'r'}` / `{t:'ia',seq}`.
   * The device may be local or remote — `controller.getHandle()` already
   * abstracts that away, so this route never needs to know which.
   *
   * Handshake (stricter than the node endpoint above, because this one talks to
   * a browser):
   * 1. Host allowlist (anti DNS-rebinding) AND Origin allowlist (anti CSWSH) —
   *    unlike the node endpoint, a browser always sends Origin, and writing to
   *    this socket injects keystrokes into a remote terminal. Failure closes 4003.
   * 2. `controller.getHandle(deviceId)` must be non-null, `controller.isOnline`
   *    must be true, and `controller.hasSession` must confirm the device
   *    actually has this session — any failure closes 4004. (Basic Auth/cookie
   *    auth for the connection itself already happened in the global auth
   *    middleware before this handler ever runs — see auth.ts.)
   * 3. Per-source-IP connection cap (MAX_TERMINAL_WS_PER_IP) — over it closes 4008.
   *
   * Once through: `handle.subscribeTerminal(sessionId, sink)` wires the fleet
   * TerminalSink to the same 8ms/16KB-batched, DEC-2026-wrapped 'o' framing the
   * local terminal WS uses (see the module doc comment on the duplicated
   * batching constants above). `{t:'i'}` forwards to `handle.writeInput` and,
   * when it carries a `seq`, ACKs with `{t:'ia',seq}` unconditionally — at
   * most-once de-duplication of a redelivered (cid,seq) happens downstream
   * (`Session.shouldApplyInput` for a local device, the remote node's own
   * `shouldApplyInput` for a node), so "forwarded" already implies "ACKable"
   * here. `{t:'z'}` forwards to `handle.resize` after the same 1-500/1-200
   * cols/rows bounds check ws-routes.ts uses.
   *
   * Teardown: `controller.on('device-offline', ...)` is registered per
   * connection (not once at module scope) specifically so it can be matched
   * back to *this* deviceId and removed in the 'close' handler — an offline
   * event for this connection's device closes 4009; the socket's own 'close'
   * (any cause) always unsubscribes the terminal sink, removes that listener,
   * and decrements the per-IP counter, so a connection never outlives its
   * subscriptions/listeners/accounting.
   */
  app.get<{ Params: { deviceId: string; sessionId: string } }>(
    '/ws/fleet/devices/:deviceId/sessions/:sessionId/terminal',
    { websocket: true },
    (socket: WebSocket, req) => {
      const policy = getHostPolicy();
      if (!isAllowedRequestHost(req.headers.host, policy) || !isAllowedRequestOrigin(req.headers.origin, policy)) {
        socket.close(4003, 'Forbidden');
        return;
      }

      const { deviceId, sessionId } = req.params;
      const handle = controller.getHandle(deviceId);
      if (!handle || !controller.isOnline(deviceId) || !controller.hasSession(deviceId, sessionId)) {
        socket.close(4004, 'Unknown device or session');
        return;
      }

      const ip = req.ip;
      const currentCount = terminalWsCountByIp.get(ip) ?? 0;
      if (currentCount >= MAX_TERMINAL_WS_PER_IP) {
        socket.close(4008, 'Too many connections');
        return;
      }
      terminalWsCountByIp.set(ip, currentCount + 1);

      // Swallow socket errors — cleanup happens in 'close' (mirrors ws-routes.ts).
      socket.on('error', () => {});

      // Per-connection micro-batch state for 'o' frames — see the module doc
      // comment above the TERM_* constants for why this duplicates ws-routes.ts
      // instead of sharing a helper.
      let batchChunks: string[] = [];
      let batchSize = 0;
      let batchTimer: ReturnType<typeof setTimeout> | null = null;

      const flushBatch = () => {
        batchTimer = null;
        if (batchChunks.length === 0 || socket.readyState !== 1) {
          batchChunks = [];
          batchSize = 0;
          return;
        }
        const data = batchChunks.join('');
        batchChunks = [];
        batchSize = 0;
        socket.send(`{"t":"o","d":${JSON.stringify(TERM_DEC_2026_START + data + TERM_DEC_2026_END)}}`);
      };

      const sink: TerminalSink = (ev) => {
        if (ev.kind === 'data') {
          if (socket.readyState !== 1) return;
          batchChunks.push(ev.data);
          batchSize += ev.data.length;
          if (batchSize > TERM_WS_BATCH_FLUSH_THRESHOLD) {
            if (batchTimer) clearTimeout(batchTimer);
            flushBatch();
            return;
          }
          if (!batchTimer) batchTimer = setTimeout(flushBatch, TERM_WS_BATCH_INTERVAL_MS);
        } else if (ev.kind === 'clear') {
          if (socket.readyState === 1) socket.send('{"t":"c"}');
        } else if (ev.kind === 'refresh') {
          if (socket.readyState === 1) socket.send('{"t":"r"}');
        }
      };

      let unsub: (() => void) | null = null;
      try {
        unsub = handle.subscribeTerminal(sessionId, sink);
      } catch {
        // Defensive: a local device's session ops look sessions up synchronously
        // and throw for an unknown id (hasSession() above only validates against
        // a remote device's session cache — see its doc comment). Treat that the
        // same as the sessionId simply not existing.
        terminalWsCountByIp.set(ip, (terminalWsCountByIp.get(ip) ?? 1) - 1);
        socket.close(4004, 'Unknown device or session');
        return;
      }

      // Attach the message handler synchronously BEFORE any async work
      // (@fastify/websocket requirement to avoid dropping the first frame).
      socket.on('message', (raw) => {
        try {
          const msg = JSON.parse(String(raw));
          if (msg.t === 'i' && typeof msg.d === 'string') {
            if (msg.d.length > MAX_INPUT_LENGTH) return;
            const cid = typeof msg.cid === 'string' ? msg.cid : undefined;
            const seq = Number.isInteger(msg.seq) ? (msg.seq as number) : undefined;
            // Forward unconditionally — dedup of a redelivered (cid,seq) happens
            // downstream, so "forwarded" already implies "ACKable" here.
            handle.writeInput(sessionId, msg.d, seq, cid);
            if (seq !== undefined && socket.readyState === 1) {
              socket.send(`{"t":"ia","seq":${seq}}`);
            }
          } else if (
            msg.t === 'z' &&
            Number.isInteger(msg.c) &&
            Number.isInteger(msg.r) &&
            msg.c >= 1 &&
            msg.c <= 500 &&
            msg.r >= 1 &&
            msg.r <= 200
          ) {
            const viewportType = msg.v === 'mobile' || msg.v === 'tablet' || msg.v === 'desktop' ? msg.v : undefined;
            const force = msg.f === true;
            handle.resize(sessionId, msg.c, msg.r, { viewportType, force });
          }
        } catch {
          // Ignore malformed messages
        }
      });

      // Per-connection listener so it can be matched back to this deviceId and
      // removed on close — see the route's doc comment above for why this isn't
      // a single module-scoped listener instead.
      const onDeviceOffline = (offlineDeviceId: string) => {
        if (offlineDeviceId === deviceId) {
          socket.close(4009, 'Device offline');
        }
      };
      controller.on('device-offline', onDeviceOffline);

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
        clearInterval(pingInterval);
        if (pongTimeout) clearTimeout(pongTimeout);
        if (batchTimer) clearTimeout(batchTimer);
        batchChunks = [];
        controller.off('device-offline', onDeviceOffline);
        unsub?.();

        const count = terminalWsCountByIp.get(ip) ?? 1;
        if (count <= 1) {
          terminalWsCountByIp.delete(ip);
        } else {
          terminalWsCountByIp.set(ip, count - 1);
        }
      });
    }
  );
}
