/**
 * @fileoverview FleetCentralController — the single in-process coordinator
 * between the fleet dashboard (REST/SSE, Task 12) and every device, whether
 * local (this process, via a `FleetDeviceHandle` registered directly) or
 * remote (a node agent connected over WebSocket, Task 9/10).
 *
 * For remote devices this module owns the request/response RPC layer over
 * the raw frame protocol (Task 3's `NodeToCentralFrame`/`CentralToNodeFrame`),
 * a per-device session cache (seeded by `hello`, kept current by
 * `heartbeat`/`session:update`), and terminal-subscription ref-counting so
 * multiple browser viewers can share a single `terminal:subscribe` on the
 * wire. It deliberately depends only on `NodeSocketLike` — a minimal
 * send/close surface — so it never imports `ws` directly and stays unit
 * testable with a plain fake socket.
 *
 * Key exports:
 * - NodeSocketLike — the minimal socket surface the controller needs
 * - FleetCentralController — the coordinator (extends EventEmitter for
 *   'broadcast' → SSE fan-out and 'device-offline' → browser WS teardown)
 */

import { EventEmitter } from 'node:events';
import type { FleetDeviceHandle } from './device-adapter.js';
import type { FleetTerminalEvent, TerminalSink } from './local-session-ops.js';
import type { DeviceRegistry } from './device-registry.js';
import {
  buildFleetSessionTab,
  type CentralToNodeFrame,
  type CreateFleetSessionRequest,
  type FleetDashboardState,
  type FleetDeviceSummary,
  type FleetSessionSummary,
  type FleetSessionTab,
  type NodeToCentralFrame,
} from './protocol.js';

/** The minimal socket surface the controller needs to talk to a node agent; kept independent of `ws` so this module stays unit-testable with a fake object. */
export interface NodeSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly bufferedAmount?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** `CentralToNodeFrame` variants that carry a `requestId` and expect an `ack`/`error` reply. */
type CentralRequestFrame = Extract<CentralToNodeFrame, { requestId: string }>;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * `FleetDeviceHandle` for a device connected over the node WebSocket. Not
 * exported — the central controller is the only thing that constructs one
 * (in `connectNode`) and routes frames into it (in `handleNodeFrame`).
 *
 * - RPC methods (`createSession`/`stopSession`/`getTerminalBuffer`) go
 *   through `request()`: monotonic `rq_${n}` ids (assigned by the
 *   controller so ids stay unique across every device), a `pending` map,
 *   and a `requestTimeoutMs` timer that rejects if no `ack`/`error` arrives.
 * - `listSessions()` never hits the wire; it returns the cache seeded by
 *   `hello` and kept current by `heartbeat`/`session:update`.
 * - `writeInput`/`resize` are fire-and-forget sends (no requestId).
 * - `subscribeTerminal` ref-counts sinks per sessionId: the first sink
 *   triggers `terminal:subscribe`, the last removal triggers
 *   `terminal:unsubscribe`. Both RPCs only `console.warn` on failure —
 *   subscription state is the sink Set, not the RPC outcome.
 */
class RemoteDeviceHandle implements FleetDeviceHandle {
  readonly deviceId: string;
  readonly socket: NodeSocketLike;

  private readonly sessions = new Map<string, FleetSessionSummary>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly sinks = new Map<string, Set<TerminalSink>>();

  constructor(
    deviceId: string,
    socket: NodeSocketLike,
    private readonly registry: DeviceRegistry,
    private readonly nextRequestId: () => string,
    private readonly requestTimeoutMs: number
  ) {
    this.deviceId = deviceId;
    this.socket = socket;
  }

  summary(): FleetDeviceSummary {
    const activeSessionCount = this.activeSessionCount();
    const registered = this.registry.getDevice(this.deviceId);
    if (registered) {
      return { ...registered, status: 'online', activeSessionCount };
    }
    // Defensive fallback: a node connected without a prior pairing record
    // (shouldn't happen in production — joining always registers first).
    return {
      id: this.deviceId,
      name: this.deviceId,
      hostname: '',
      platform: '',
      arch: '',
      username: '',
      version: '',
      status: 'online',
      lastSeenAt: Date.now(),
      activeSessionCount,
      capabilities: { tmux: false, claude: false, codex: false, shell: false },
    };
  }

  listSessions(): Promise<FleetSessionSummary[]> {
    return Promise.resolve(this.sessionList());
  }

  async createSession(input: CreateFleetSessionRequest): Promise<FleetSessionSummary> {
    const data = await this.request((requestId) => ({ t: 'create-session', requestId, payload: input }));
    return data as FleetSessionSummary;
  }

  async stopSession(sessionId: string): Promise<void> {
    await this.request((requestId) => ({ t: 'stop-session', requestId, sessionId }));
  }

  writeInput(sessionId: string, data: string, seq?: number, cid?: string): void {
    this.send({ t: 'terminal:input', sessionId, data, seq, cid });
  }

  resize(sessionId: string, cols: number, rows: number, opts?: { viewportType?: string; force?: boolean }): void {
    this.send({ t: 'terminal:resize', sessionId, cols, rows, viewportType: opts?.viewportType, force: opts?.force });
  }

  subscribeTerminal(sessionId: string, sink: TerminalSink): () => void {
    let set = this.sinks.get(sessionId);
    if (!set) {
      set = new Set();
      this.sinks.set(sessionId, set);
    }
    const isFirstSink = set.size === 0;
    set.add(sink);
    if (isFirstSink) {
      this.request((requestId) => ({ t: 'terminal:subscribe', requestId, sessionId })).catch((err: unknown) => {
        console.warn(`[FleetCentralController] terminal:subscribe failed for ${this.deviceId}/${sessionId}:`, err);
      });
    }

    let unsubscribed = false;
    return () => {
      if (unsubscribed) return; // idempotent: a second call is a no-op, not a double-decrement
      unsubscribed = true;
      const current = this.sinks.get(sessionId);
      if (!current || !current.delete(sink)) return;
      if (current.size === 0) {
        this.sinks.delete(sessionId);
        this.request((requestId) => ({ t: 'terminal:unsubscribe', requestId, sessionId })).catch((err: unknown) => {
          console.warn(`[FleetCentralController] terminal:unsubscribe failed for ${this.deviceId}/${sessionId}:`, err);
        });
      }
    };
  }

  async getTerminalBuffer(sessionId: string): Promise<string> {
    const data = await this.request((requestId) => ({ t: 'get-buffer', requestId, sessionId }));
    return data as string;
  }

  // ---- internal: driven only by FleetCentralController ----

  activeSessionCount(): number {
    let count = 0;
    for (const s of this.sessions.values()) if (s.status !== 'stopped') count++;
    return count;
  }

  sessionList(): FleetSessionSummary[] {
    return [...this.sessions.values()];
  }

  /** Cheap change-detector for heartbeat de-duplication. */
  sessionsFingerprint(): string {
    return JSON.stringify(this.sessionList());
  }

  replaceSessions(sessions: FleetSessionSummary[]): void {
    this.sessions.clear();
    for (const s of sessions) this.sessions.set(s.id, s);
  }

  upsertSession(session: FleetSessionSummary): void {
    this.sessions.set(session.id, session);
  }

  fanOutTerminal(sessionId: string, event: FleetTerminalEvent): void {
    const set = this.sinks.get(sessionId);
    if (!set) return;
    for (const sink of set) sink(event);
  }

  resolvePending(requestId: string, data: unknown): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    clearTimeout(p.timer);
    p.resolve(data);
  }

  rejectPendingById(requestId: string | undefined, message: string): void {
    if (requestId == null) return;
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    clearTimeout(p.timer);
    p.reject(new Error(message));
  }

  /** Rejects and clears every in-flight request — used on disconnect and when a stale connection is replaced. */
  rejectAllPending(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  /** Drops every subscription without telling the node (socket is gone/replaced; nothing to unsubscribe on the wire). */
  clearSinksSilently(): void {
    this.sinks.clear();
  }

  private send(frame: CentralToNodeFrame): void {
    this.socket.send(JSON.stringify(frame));
  }

  private request(build: (requestId: string) => CentralRequestFrame): Promise<unknown> {
    const requestId = this.nextRequestId();
    const frame = build(requestId);
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('Fleet node request timed out'));
      }, this.requestTimeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.send(frame);
    });
  }
}

/**
 * The single in-process coordinator between the dashboard and every fleet
 * device. Local devices are registered directly via `registerLocalDevice`;
 * remote devices are represented by an internal `RemoteDeviceHandle` created
 * in `connectNode` and torn down in `disconnectNode`. Both are exposed
 * uniformly through `getHandle()`.
 *
 * Emits (consumed by the server's SSE wiring / browser terminal WS route):
 * - `'broadcast', 'fleet:device-online', FleetDeviceSummary`
 * - `'broadcast', 'fleet:device-offline', { deviceId }`
 * - `'broadcast', 'fleet:sessions-updated', { deviceId, sessions }`
 * - `'device-offline', deviceId` — so a browser terminal WS route can close its socket (4009)
 */
export class FleetCentralController extends EventEmitter {
  private readonly localDevices = new Map<string, FleetDeviceHandle>();
  private readonly remoteHandles = new Map<string, RemoteDeviceHandle>();
  private readonly requestTimeoutMs: number;
  private requestSeq = 0;

  constructor(
    private readonly registry: DeviceRegistry,
    opts?: { requestTimeoutMs?: number }
  ) {
    super();
    this.requestTimeoutMs = opts?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  registerLocalDevice(handle: FleetDeviceHandle): void {
    this.localDevices.set(handle.deviceId, handle);
  }

  connectNode(deviceId: string, socket: NodeSocketLike, hello: Extract<NodeToCentralFrame, { t: 'hello' }>): void {
    const existing = this.remoteHandles.get(deviceId);
    if (existing) {
      // Replace, don't disconnect: closing the stale socket and settling its
      // own pending/sinks must NOT touch registry/offline state, or run any
      // cleanup that could clobber the new connection we're about to install.
      existing.socket.close(4000, 'replaced');
      existing.rejectAllPending(new Error('Device disconnected'));
      existing.clearSinksSilently();
    }

    const handle = new RemoteDeviceHandle(
      deviceId,
      socket,
      this.registry,
      () => this.nextRequestId(),
      this.requestTimeoutMs
    );
    handle.replaceSessions(hello.sessions);
    this.remoteHandles.set(deviceId, handle);
    this.registry.markOnline(deviceId);
    this.emit('broadcast', 'fleet:device-online', handle.summary());
  }

  /**
   * Tears down a remote device's connection. When `socket` is provided and it no longer
   * matches the handle's current socket, this is a no-op: it's a stale/asynchronous `close`
   * event from a socket that `connectNode` already replaced, and must not clobber the fresh
   * connection. Omit `socket` to force disconnection unconditionally (existing behavior).
   */
  disconnectNode(deviceId: string, socket?: NodeSocketLike): void {
    const handle = this.remoteHandles.get(deviceId);
    if (!handle) return;
    if (socket && handle.socket !== socket) return; // stale close from a replaced socket
    this.remoteHandles.delete(deviceId);
    handle.rejectAllPending(new Error('Device disconnected'));
    handle.clearSinksSilently();
    this.registry.markOffline(deviceId);
    this.emit('broadcast', 'fleet:device-offline', { deviceId });
    this.emit('device-offline', deviceId);
  }

  handleNodeFrame(deviceId: string, frame: NodeToCentralFrame): void {
    const handle = this.remoteHandles.get(deviceId);
    if (!handle) return; // stale/unknown-device frame (e.g. arrived after disconnect) — ignore

    switch (frame.t) {
      case 'hello':
        // The initial handshake is handled by connectNode(); a stray hello here is ignored.
        break;
      case 'heartbeat': {
        const before = handle.sessionsFingerprint();
        handle.replaceSessions(frame.sessions);
        this.registry.markOnline(deviceId);
        if (handle.sessionsFingerprint() !== before) {
          this.emit('broadcast', 'fleet:sessions-updated', { deviceId, sessions: handle.sessionList() });
        }
        break;
      }
      case 'session:update':
        handle.upsertSession(frame.session);
        this.registry.markOnline(deviceId);
        this.emit('broadcast', 'fleet:sessions-updated', { deviceId, sessions: handle.sessionList() });
        break;
      case 'terminal:data':
        handle.fanOutTerminal(frame.sessionId, { kind: 'data', data: frame.data });
        break;
      case 'terminal:clear':
        handle.fanOutTerminal(frame.sessionId, { kind: 'clear' });
        break;
      case 'terminal:refresh':
        handle.fanOutTerminal(frame.sessionId, { kind: 'refresh' });
        break;
      case 'ack':
        handle.resolvePending(frame.requestId, frame.data);
        break;
      case 'error':
        handle.rejectPendingById(frame.requestId, frame.message);
        break;
    }
  }

  isOnline(deviceId: string): boolean {
    return this.localDevices.has(deviceId) || this.remoteHandles.has(deviceId);
  }

  getHandle(deviceId: string): FleetDeviceHandle | null {
    return this.localDevices.get(deviceId) ?? this.remoteHandles.get(deviceId) ?? null;
  }

  async getDashboardState(): Promise<FleetDashboardState> {
    const devices: FleetDeviceSummary[] = [];
    for (const local of this.localDevices.values()) devices.push(local.summary());
    for (const registered of this.registry.listDevices()) {
      const handle = this.remoteHandles.get(registered.id);
      devices.push(
        handle ? { ...registered, status: 'online', activeSessionCount: handle.activeSessionCount() } : registered
      );
    }
    devices.sort(compareDevices);

    const sessions: FleetSessionSummary[] = [];
    for (const local of this.localDevices.values()) sessions.push(...(await local.listSessions()));
    for (const handle of this.remoteHandles.values()) sessions.push(...handle.sessionList());

    const sessionTabs: FleetSessionTab[] = [];
    for (const local of this.localDevices.values()) {
      const summary = local.summary();
      for (const session of await local.listSessions()) {
        if (session.status !== 'stopped') sessionTabs.push(buildFleetSessionTab(summary, session));
      }
    }
    for (const handle of this.remoteHandles.values()) {
      const summary = handle.summary();
      for (const session of handle.sessionList()) {
        if (session.status !== 'stopped') sessionTabs.push(buildFleetSessionTab(summary, session));
      }
    }

    return { devices, sessions, sessionTabs, generatedAt: Date.now() };
  }

  private nextRequestId(): string {
    this.requestSeq += 1;
    return `rq_${this.requestSeq}`;
  }
}

/** online first → has-active-sessions first → lastSeenAt descending */
function compareDevices(a: FleetDeviceSummary, b: FleetDeviceSummary): number {
  if (a.status !== b.status) return a.status === 'online' ? -1 : 1;
  const aActive = a.activeSessionCount > 0;
  const bActive = b.activeSessionCount > 0;
  if (aActive !== bActive) return aActive ? -1 : 1;
  return b.lastSeenAt - a.lastSeenAt;
}
