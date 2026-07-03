/**
 * @fileoverview FleetNodeAgent — the client side of the fleet wire protocol.
 *
 * Runs INSIDE a `codeman web` / `codeman node run` process on a node device
 * (e.g. a macmini). It opens a WebSocket to a central controller's
 * `/ws/fleet/node` endpoint (Task 9), authenticates with the Bearer token +
 * device-id persisted by `codeman node join` (Task 5's fleet-node.json), and
 * then bridges the central's remote-control frames to the local in-process
 * session ops (Task 7's `LocalSessionOps`).
 *
 * It is the mirror image of Task 8's `RemoteDeviceHandle`: where that class
 * (on the central) turns dashboard calls into `CentralToNodeFrame`s and awaits
 * `ack`/`error`, this agent (on the node) receives those frames, executes them
 * against `LocalSessionOps`, and replies with `ack`/`error`. It also pushes
 * `hello`/`heartbeat` and streams terminal output (`terminal:data`/`clear`/
 * `refresh`) back up.
 *
 * Responsibilities:
 * - Connect + reconnect with exponential backoff (1s→2s→4s… capped 30s); a
 *   successful open resets the backoff. `stop()` halts everything and prevents
 *   any further reconnect.
 * - Send `hello` on open and a periodic `heartbeat` (default every 10s).
 * - Route each `CentralToNodeFrame` to `LocalSessionOps` (see the frame table
 *   in the switch below) and reply with `ack`/`error` for request frames.
 * - Batch terminal `data` per session (8ms flush, or immediate flush at ≥16KB)
 *   with socket backpressure handling (drop + `terminal:refresh` on recovery).
 *   `clear`/`refresh` sink events are flushed and sent immediately.
 * - Clean up all subscriptions, the heartbeat timer, and batch timers on socket
 *   close and on `stop()` — no timer/listener leaks after `stop()`.
 *
 * Key exports:
 * - FleetNodeAgent — the agent (constructor opts are injectable for tests)
 * - startFleetNodeAgentIfConfigured — reads fleet-node.json and, if present,
 *   builds a LocalSessionOps against the server's route context and starts an
 *   agent. Returns null when the device isn't joined to a fleet.
 */

import WebSocket from 'ws';
import { getErrorMessage } from '../types.js';
import {
  FLEET_PROTOCOL_VERSION,
  parseCentralToNodeFrame,
  type CentralToNodeFrame,
  type ExternalSessionCandidate,
  type FleetDeviceSummary,
  type NodeToCentralFrame,
} from './protocol.js';
import type { LocalSessionOps, TerminalSink } from './local-session-ops.js';
import type { SessionCoreCtx } from '../web/route-helpers.js';
import { collectDeviceJoinInfo, readFleetNodeConfig, type FleetNodeConfig } from './node-config.js';
import { createLocalSessionOps } from './local-session-ops.js';
import { ExternalSessionScanner } from './external-session-scanner.js';
import { resolveConfiguredTmuxSocket } from '../tmux-manager.js';

/**
 * The subset of ExternalSessionScanner the agent drives — injectable so tests
 * can supply a controllable fake instead of one that execs `ps`/`tmux`.
 */
export interface ExternalScannerLike {
  start(): void;
  stop(): void;
  getCandidates(): ExternalSessionCandidate[];
  on(event: 'changed', listener: (candidates: ExternalSessionCandidate[]) => void): void;
}

/** Micro-batch interval for terminal output (ms) — mirrors ws-routes.ts's browser WS cadence. */
const FLUSH_INTERVAL_MS = 8;

/** Flush a session's terminal batch immediately once it reaches this many bytes. */
const IMMEDIATE_FLUSH_BYTES = 16 * 1024;

/** Above this socket backpressure, drop the batch and mark the session for a refresh. */
const BACKPRESSURE_DROP_BYTES = 512 * 1024;

/** Once backpressure falls below this, send one `terminal:refresh` to resync a dropped session. */
const BACKPRESSURE_RESUME_BYTES = 64 * 1024;

/** Default heartbeat cadence (ms). */
const DEFAULT_HEARTBEAT_MS = 10_000;

/** Default reconnect backoff floor / ceiling (ms): 1s → 2s → 4s … capped at 30s. */
const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;

/** ws.WebSocket.OPEN — avoid depending on the instance constant so injected fakes work. */
const WS_OPEN = 1;

/** The minimal socket surface the agent drives; `ws.WebSocket` structurally satisfies it. */
export interface NodeAgentSocket {
  readyState: number;
  bufferedAmount?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'open', cb: () => void): void;
  on(event: 'message', cb: (data: unknown) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
}

export interface FleetNodeAgentOpts {
  config: FleetNodeConfig;
  ops: LocalSessionOps;
  /** Static device identity; the agent fills status/lastSeenAt/activeSessionCount when it sends `hello`. */
  device: FleetDeviceSummary;
  /** Test seam — defaults to `new WebSocket(url, { headers })` from the `ws` package. */
  wsFactory?: (url: string, headers: Record<string, string>) => NodeAgentSocket;
  /** Heartbeat cadence (ms). Default 10s. */
  heartbeatMs?: number;
  /** Reconnect backoff floor (ms). Default 1s. */
  reconnectBaseMs?: number;
  /** Reconnect backoff ceiling (ms). Default 30s. */
  reconnectMaxMs?: number;
  /** External-tmux-session scanner. Default: a real one bound to `ownSocket` (or the configured codeman socket). */
  scanner?: ExternalScannerLike;
  /** This instance's own codeman tmux socket (excluded from scanning). Only used to build the default scanner. */
  ownSocket?: string;
}

/** Per-session terminal output batch. */
interface TerminalBatch {
  buffer: string;
  bytes: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Set when a batch was dropped due to backpressure; cleared by sending `terminal:refresh`. */
  needRefresh: boolean;
}

export class FleetNodeAgent {
  private readonly config: FleetNodeConfig;
  private readonly ops: LocalSessionOps;
  private readonly device: FleetDeviceSummary;
  private readonly wsFactory: (url: string, headers: Record<string, string>) => NodeAgentSocket;
  private readonly heartbeatMs: number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly scanner: ExternalScannerLike;

  private ws: NodeAgentSocket | null = null;
  private stopped = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  /** sessionId → unsubscribe fn for every live `terminal:subscribe`. */
  private readonly subs = new Map<string, () => void>();
  /** sessionId → pending terminal output batch. */
  private readonly batches = new Map<string, TerminalBatch>();

  constructor(opts: FleetNodeAgentOpts) {
    this.config = opts.config;
    this.ops = opts.ops;
    this.device = opts.device;
    this.wsFactory =
      opts.wsFactory ?? ((url, headers) => new WebSocket(url, { headers }) as unknown as NodeAgentSocket);
    this.heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.reconnectBaseMs = opts.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    this.scanner =
      opts.scanner ?? new ExternalSessionScanner({ ownSocket: opts.ownSocket ?? resolveConfiguredTmuxSocket() });
    // Forward every discovered external-session change; send() no-ops while the socket is down.
    this.scanner.on('changed', (candidates) => this.sendExternalSessions(candidates));
  }

  /** Connect to the central controller; auto-reconnects with backoff until `stop()`. */
  start(): void {
    this.stopped = false;
    this.connect();
  }

  /** Stop the heartbeat, close the connection, and prevent any further reconnect. */
  stop(): void {
    this.stopped = true;
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.scanner.stop();
    this.unsubscribeAll();
    this.clearAllBatches();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        /* ignore — socket may already be closing */
      }
    }
  }

  // ---- connection lifecycle ----

  private connect(): void {
    const url = `${toWsUrl(this.config.centralUrl)}/ws/fleet/node`;
    const headers = {
      authorization: `Bearer ${this.config.token}`,
      'x-codeman-device-id': this.config.deviceId,
    };

    let ws: NodeAgentSocket;
    try {
      ws = this.wsFactory(url, headers);
    } catch (err) {
      // Synchronous construction failure (e.g. malformed URL) — treat like a
      // dropped connection and back off, unless we've been stopped.
      console.warn('[FleetNodeAgent] connect failed:', getErrorMessage(err));
      if (!this.stopped) this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      if (this.stopped || this.ws !== ws) return;
      this.reconnectAttempt = 0; // successful connection resets backoff
      this.sendHello();
      this.startHeartbeat();
      // Start external-tmux discovery (idempotent) and push the current snapshot
      // right after hello; further changes flow via the scanner's 'changed' event.
      this.scanner.start();
      this.sendExternalSessions(this.scanner.getCandidates());
    });

    ws.on('message', (raw) => {
      if (this.ws !== ws) return; // frame from a superseded socket — ignore
      this.handleRawFrame(raw);
    });

    ws.on('error', (err) => {
      // Log only; 'ws' always follows an error with a 'close', which handles reconnect.
      console.warn('[FleetNodeAgent] socket error:', getErrorMessage(err));
    });

    ws.on('close', () => {
      if (this.ws !== ws) return; // stale close from a superseded socket — ignore
      this.ws = null;
      this.stopHeartbeat();
      this.unsubscribeAll();
      this.clearAllBatches();
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(this.reconnectBaseMs * 2 ** this.reconnectAttempt, this.reconnectMaxMs);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ---- outbound frames ----

  private sendHello(): void {
    const sessions = this.ops.listSessions();
    this.send({
      t: 'hello',
      protocol: FLEET_PROTOCOL_VERSION,
      device: {
        ...this.device,
        status: 'online',
        lastSeenAt: Date.now(),
        activeSessionCount: sessions.filter((s) => s.status !== 'stopped').length,
      },
      sessions,
    });
  }

  /** Report the current external-tmux-session candidates (no-op while the socket is down). */
  private sendExternalSessions(candidates: ExternalSessionCandidate[]): void {
    this.send({ t: 'external-sessions', candidates });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ t: 'heartbeat', sessions: this.ops.listSessions() });
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private send(frame: NodeToCentralFrame): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WS_OPEN) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch (err) {
      console.warn('[FleetNodeAgent] send failed:', getErrorMessage(err));
    }
  }

  // ---- inbound frame handling ----

  private handleRawFrame(raw: unknown): void {
    const frame = parseCentralToNodeFrame(String(raw));
    if (!frame) return; // unparseable — drop silently (central owns framing discipline)
    void this.handleFrame(frame);
  }

  private async handleFrame(frame: CentralToNodeFrame): Promise<void> {
    switch (frame.t) {
      case 'list-sessions':
        this.send({ t: 'ack', requestId: frame.requestId, data: this.ops.listSessions() });
        break;

      case 'create-session':
        try {
          const data = await this.ops.createSession(frame.payload);
          this.send({ t: 'ack', requestId: frame.requestId, data });
        } catch (err) {
          this.send({ t: 'error', requestId: frame.requestId, message: getErrorMessage(err) });
        }
        break;

      case 'stop-session':
        try {
          await this.ops.stopSession(frame.sessionId);
          this.send({ t: 'ack', requestId: frame.requestId });
        } catch (err) {
          this.send({ t: 'error', requestId: frame.requestId, message: getErrorMessage(err) });
        }
        break;

      case 'get-buffer':
        try {
          const data = await this.ops.getTerminalBuffer(frame.sessionId);
          this.send({ t: 'ack', requestId: frame.requestId, data });
        } catch (err) {
          this.send({ t: 'error', requestId: frame.requestId, message: getErrorMessage(err) });
        }
        break;

      case 'list-resume-candidates':
        try {
          const data = await this.ops.listResumeCandidates();
          this.send({ t: 'ack', requestId: frame.requestId, data });
        } catch (err) {
          this.send({ t: 'error', requestId: frame.requestId, message: getErrorMessage(err) });
        }
        break;

      case 'list-dirs':
        try {
          const data = await this.ops.listDirs(frame.path);
          this.send({ t: 'ack', requestId: frame.requestId, data });
        } catch (err) {
          this.send({ t: 'error', requestId: frame.requestId, message: getErrorMessage(err) });
        }
        break;

      case 'terminal:input':
        try {
          this.ops.writeInput(frame.sessionId, frame.data, frame.seq, frame.cid);
        } catch (err) {
          console.warn('[FleetNodeAgent] writeInput failed:', getErrorMessage(err));
        }
        break;

      case 'terminal:resize':
        try {
          this.ops.resize(frame.sessionId, frame.cols, frame.rows, {
            viewportType: frame.viewportType,
            force: frame.force,
          });
        } catch (err) {
          console.warn('[FleetNodeAgent] resize failed:', getErrorMessage(err));
        }
        break;

      case 'terminal:subscribe':
        this.subscribe(frame.sessionId);
        this.send({ t: 'ack', requestId: frame.requestId });
        break;

      case 'terminal:unsubscribe':
        this.unsubscribe(frame.sessionId);
        this.send({ t: 'ack', requestId: frame.requestId });
        break;
    }
  }

  // ---- terminal subscription + batching ----

  private subscribe(sessionId: string): void {
    if (this.subs.has(sessionId)) return; // idempotent: reuse the existing session listener
    try {
      const unsub = this.ops.subscribeTerminal(sessionId, this.makeSink(sessionId));
      this.subs.set(sessionId, unsub);
    } catch (err) {
      console.warn('[FleetNodeAgent] subscribeTerminal failed:', getErrorMessage(err));
    }
  }

  private unsubscribe(sessionId: string): void {
    const unsub = this.subs.get(sessionId);
    if (unsub) {
      this.subs.delete(sessionId);
      try {
        unsub();
      } catch {
        /* ignore */
      }
    }
    this.clearBatch(sessionId);
  }

  private unsubscribeAll(): void {
    for (const unsub of this.subs.values()) {
      try {
        unsub();
      } catch {
        /* ignore */
      }
    }
    this.subs.clear();
  }

  private makeSink(sessionId: string): TerminalSink {
    return (ev) => {
      if (this.stopped) return;
      if (ev.kind === 'data') {
        this.onTerminalData(sessionId, ev.data);
      } else {
        // clear/refresh are control events: flush any pending data first to keep
        // ordering, then send the control frame immediately (never batched).
        this.flushBatch(sessionId);
        this.send({ t: ev.kind === 'clear' ? 'terminal:clear' : 'terminal:refresh', sessionId });
      }
    };
  }

  private onTerminalData(sessionId: string, data: string): void {
    const batch = this.getBatch(sessionId);
    // If a prior drop left us needing a refresh and backpressure has recovered, send it now.
    this.maybeSendRefresh(sessionId, batch);
    batch.buffer += data;
    batch.bytes += Buffer.byteLength(data, 'utf8');
    if (batch.bytes >= IMMEDIATE_FLUSH_BYTES) {
      this.flushBatch(sessionId);
    } else if (!batch.timer) {
      batch.timer = setTimeout(() => this.flushBatch(sessionId), FLUSH_INTERVAL_MS);
      batch.timer.unref?.();
    }
  }

  private flushBatch(sessionId: string): void {
    const batch = this.batches.get(sessionId);
    if (!batch) return;
    if (batch.timer) {
      clearTimeout(batch.timer);
      batch.timer = null;
    }
    if (batch.buffer.length === 0) return;

    if (this.bufferedAmount() > BACKPRESSURE_DROP_BYTES) {
      // Socket is congested — drop this batch and remember to resync via refresh.
      batch.buffer = '';
      batch.bytes = 0;
      batch.needRefresh = true;
      return;
    }

    // If we owe a refresh and backpressure has recovered, send it before the fresh data.
    this.maybeSendRefresh(sessionId, batch);

    const data = batch.buffer;
    batch.buffer = '';
    batch.bytes = 0;
    this.send({ t: 'terminal:data', sessionId, data });
  }

  private maybeSendRefresh(sessionId: string, batch: TerminalBatch): void {
    if (batch.needRefresh && this.bufferedAmount() < BACKPRESSURE_RESUME_BYTES) {
      batch.needRefresh = false;
      this.send({ t: 'terminal:refresh', sessionId });
    }
  }

  private getBatch(sessionId: string): TerminalBatch {
    let batch = this.batches.get(sessionId);
    if (!batch) {
      batch = { buffer: '', bytes: 0, timer: null, needRefresh: false };
      this.batches.set(sessionId, batch);
    }
    return batch;
  }

  private clearBatch(sessionId: string): void {
    const batch = this.batches.get(sessionId);
    if (batch?.timer) clearTimeout(batch.timer);
    this.batches.delete(sessionId);
  }

  private clearAllBatches(): void {
    for (const batch of this.batches.values()) {
      if (batch.timer) clearTimeout(batch.timer);
    }
    this.batches.clear();
  }

  private bufferedAmount(): number {
    return this.ws?.bufferedAmount ?? 0;
  }
}

/** http→ws / https→wss, stripping any trailing slash. Non-http(s) inputs pass through unchanged. */
function toWsUrl(centralUrl: string): string {
  const trimmed = centralUrl.replace(/\/+$/, '');
  if (trimmed.startsWith('https://')) return `wss://${trimmed.slice('https://'.length)}`;
  if (trimmed.startsWith('http://')) return `ws://${trimmed.slice('http://'.length)}`;
  return trimmed;
}

/**
 * If this device has been paired (fleet-node.json exists), build a
 * `LocalSessionOps` against the server's route `ctx`, construct a
 * `FleetNodeAgent`, start it, and return it. Returns null when the device isn't
 * joined to a fleet (no config), so the caller can no-op.
 *
 * `ctx` must be the SAME route context object the server's routes use, so the
 * agent operates on the live session map (not a stale copy).
 */
export function startFleetNodeAgentIfConfigured(ctx: SessionCoreCtx): FleetNodeAgent | null {
  const config = readFleetNodeConfig();
  if (!config) return null;

  const info = collectDeviceJoinInfo(config.deviceName);
  const device: FleetDeviceSummary = {
    id: config.deviceId,
    name: info.name,
    hostname: info.hostname,
    platform: info.platform,
    arch: info.arch,
    username: info.username,
    version: info.version,
    status: 'online',
    lastSeenAt: Date.now(),
    activeSessionCount: 0,
    capabilities: info.capabilities,
  };

  const ops = createLocalSessionOps(config.deviceId, ctx);
  const agent = new FleetNodeAgent({ config, ops, device });
  agent.start();
  return agent;
}
