/**
 * @fileoverview FleetDeviceHandle + LocalDeviceAdapter — the device-facing
 * contract the central controller (Task 8) talks to, and its local
 * (same-process) implementation.
 *
 * `LocalDeviceAdapter` is a pure delegate: every session operation forwards
 * to a `LocalSessionOps` (Task 7's local-session-ops.ts); only `summary()`
 * adds device-identity bookkeeping (host facts via node:os, online status,
 * active session count). A future remote-node adapter (Task 9/10) will
 * implement the same `FleetDeviceHandle` contract over the node WebSocket,
 * so the central controller never needs to know whether a device is local
 * or remote.
 *
 * Key exports:
 * - FleetDeviceHandle — the device-facing operations contract
 * - LocalDeviceAdapter — delegates every method to a LocalSessionOps
 */

import { arch, hostname, platform, userInfo } from 'node:os';
import type {
  CreateFleetSessionRequest,
  FleetCapabilities,
  FleetDeviceSummary,
  FleetSessionSummary,
} from './protocol.js';
import type { LocalSessionOps, TerminalSink } from './local-session-ops.js';

/**
 * Device-facing operations the central controller performs against one
 * fleet device (local or remote). Mirrors LocalSessionOps plus `summary()`
 * for device-level bookkeeping (status/host facts/active session count).
 */
export interface FleetDeviceHandle {
  readonly deviceId: string;
  summary(): FleetDeviceSummary;
  listSessions(): Promise<FleetSessionSummary[]>;
  createSession(input: CreateFleetSessionRequest): Promise<FleetSessionSummary>;
  stopSession(sessionId: string): Promise<void>;
  writeInput(sessionId: string, data: string, seq?: number, cid?: string): void;
  resize(sessionId: string, cols: number, rows: number, opts?: { viewportType?: string; force?: boolean }): void;
  subscribeTerminal(sessionId: string, sink: TerminalSink): () => void;
  getTerminalBuffer(sessionId: string): Promise<string>;
}

/**
 * FleetDeviceHandle for the local device (this process). A thin, pure
 * delegate over a LocalSessionOps: every session method forwards as-is
 * (`listSessions` additionally wraps the sync result in a resolved Promise
 * to satisfy the async FleetDeviceHandle contract shared with remote nodes).
 */
export class LocalDeviceAdapter implements FleetDeviceHandle {
  readonly deviceId: string;

  constructor(
    private readonly identity: { deviceId: string; name: string; version: string; capabilities: FleetCapabilities },
    private readonly ops: LocalSessionOps
  ) {
    this.deviceId = identity.deviceId;
  }

  summary(): FleetDeviceSummary {
    return {
      id: this.identity.deviceId,
      name: this.identity.name,
      hostname: hostname(),
      platform: platform(),
      arch: arch(),
      username: userInfo().username,
      version: this.identity.version,
      status: 'online',
      lastSeenAt: Date.now(),
      activeSessionCount: this.ops.listSessions().filter((s) => s.status !== 'stopped').length,
      capabilities: this.identity.capabilities,
    };
  }

  listSessions(): Promise<FleetSessionSummary[]> {
    return Promise.resolve(this.ops.listSessions());
  }

  createSession(input: CreateFleetSessionRequest): Promise<FleetSessionSummary> {
    return this.ops.createSession(input);
  }

  stopSession(sessionId: string): Promise<void> {
    return this.ops.stopSession(sessionId);
  }

  writeInput(sessionId: string, data: string, seq?: number, cid?: string): void {
    this.ops.writeInput(sessionId, data, seq, cid);
  }

  resize(sessionId: string, cols: number, rows: number, opts?: { viewportType?: string; force?: boolean }): void {
    this.ops.resize(sessionId, cols, rows, opts);
  }

  subscribeTerminal(sessionId: string, sink: TerminalSink): () => void {
    return this.ops.subscribeTerminal(sessionId, sink);
  }

  getTerminalBuffer(sessionId: string): Promise<string> {
    return this.ops.getTerminalBuffer(sessionId);
  }
}
