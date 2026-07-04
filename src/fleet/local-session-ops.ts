/**
 * @fileoverview LocalSessionOps — the only fleet module that reaches into
 * Session/route-context internals directly.
 *
 * Wraps the shared session lifecycle core (Task 6's `createSessionCore` /
 * `deleteSessionCore` / `readSessionTerminalBuffer` in ../web/route-helpers.ts)
 * with fleet's wire-protocol types (Task 3's ./protocol.js), so device-adapter.ts
 * (and later, the node WS endpoint) never has to import `Session` or touch
 * `ctx.sessions` itself.
 *
 * Key exports:
 * - LocalSessionOps — the fleet-facing session operations contract
 * - createLocalSessionOps — builds a LocalSessionOps for the local device
 *   (this process), stamping every FleetSessionSummary with `deviceId`
 * - sessionStatusForFleet — maps Session's live status to FleetSessionStatus
 */

import { basename } from 'node:path';
import type { Session } from '../session.js';
import {
  createSessionCore,
  deleteSessionCore,
  readSessionTerminalBuffer,
  type SessionCoreCtx,
} from '../web/route-helpers.js';
import { listHistorySessions, type HistorySession } from '../web/history-sessions-core.js';
import { listDirsSafe } from './dir-listing.js';
import { adoptSessionCore } from './adopt-session.js';
import type {
  CreateFleetSessionRequest,
  ExternalSessionCandidate,
  FleetSessionMode,
  FleetSessionStatus,
  FleetSessionSummary,
  ResumeCandidate,
} from './protocol.js';

/** A single terminal event forwarded from a live Session to a fleet subscriber. */
export type FleetTerminalEvent = { kind: 'data'; data: string } | { kind: 'clear' } | { kind: 'refresh' };

/** Callback a fleet subscriber registers to receive terminal events for one session. */
export type TerminalSink = (ev: FleetTerminalEvent) => void;

const FLEET_SESSION_MODES: readonly FleetSessionMode[] = ['claude', 'shell', 'opencode', 'codex', 'gemini'];

/**
 * Fleet-facing session operations for one device. `createLocalSessionOps`
 * implements this against the local in-process `ctx`; a future remote-node
 * implementation (Task 9/10) will implement the same contract over WebSocket
 * RPC, so callers (device-adapter.ts, the central controller) never need to
 * know whether a device is local or remote.
 */
export interface LocalSessionOps {
  listSessions(): FleetSessionSummary[];
  createSession(input: CreateFleetSessionRequest): Promise<FleetSessionSummary>;
  /** Adopt a discovered foreign-tmux session (Rev5 §13.2). Detach-only lifecycle. */
  adoptSession(candidate: ExternalSessionCandidate): Promise<FleetSessionSummary>;
  stopSession(sessionId: string): Promise<void>;
  /** Applies `data` to the session's PTY, deduping via `shouldApplyInput` when `seq`/`cid` are given (at-most-once). */
  writeInput(sessionId: string, data: string, seq?: number, cid?: string): void;
  resize(sessionId: string, cols: number, rows: number, opts?: { viewportType?: string; force?: boolean }): void;
  /** Subscribes to terminal data/clear/refresh events for a session; returns an unsubscribe function. */
  subscribeTerminal(sessionId: string, sink: TerminalSink): () => void;
  getTerminalBuffer(sessionId: string): Promise<string>;
  /** Resumable past Claude conversations on this device (same core as `GET /api/history/sessions`). */
  listResumeCandidates(): Promise<ResumeCandidate[]>;
  /** Immediate subdirectories of `path` (default `$HOME`), confined to home. Throws 'Path outside home' on escape. */
  listDirs(path?: string): Promise<{ path: string; dirs: string[] }>;
}

/** Map a history-listing row to the fleet ResumeCandidate wire shape. */
export function historySessionToResumeCandidate(h: HistorySession): ResumeCandidate {
  return {
    sessionId: h.sessionId,
    workingDir: h.workingDir,
    // Prefer the sniffed first prompt; fall back to the workspace basename, then the id.
    title: h.firstPrompt || basename(h.workingDir) || h.sessionId,
    updatedAt: new Date(h.lastModified).getTime(),
    projectKey: h.projectKey,
  };
}

/**
 * Build the fleet-facing session ops for the local device (this process).
 * `deviceId` is stamped onto every FleetSessionSummary so callers can treat
 * local and remote sessions uniformly once aggregated by the central controller.
 */
export function createLocalSessionOps(
  deviceId: string,
  ctx: SessionCoreCtx,
  opts?: {
    /** This device's current external-session candidates (scanner cache), used
     *  to reject an adopt request for a candidate that has since vanished. */
    getExternalCandidates?: () => ExternalSessionCandidate[];
  }
): LocalSessionOps {
  const toSummary = (s: Session): FleetSessionSummary => ({
    deviceId,
    id: s.id,
    name: s.name || undefined,
    remark: s.remark || undefined,
    mode: s.mode as FleetSessionMode,
    status: sessionStatusForFleet(s),
    workingDir: s.workingDir,
    pid: s.pid ?? null,
    createdAt: s.createdAt,
    lastActivityAt: s.lastActivityAt,
    adopted: s.isAdopted || undefined,
  });

  return {
    listSessions: () => [...ctx.sessions.values()].map(toSummary),

    createSession: async (input) => {
      if (input.mode && !FLEET_SESSION_MODES.includes(input.mode)) {
        throw new Error(`Unknown mode ${input.mode}`);
      }
      const session = await createSessionCore(
        ctx,
        {
          workingDir: input.workingDir,
          mode: input.mode ?? 'claude',
          name: input.name,
          resumeSessionId: input.resumeSessionId,
        },
        { start: true }
      );
      return toSummary(session);
    },

    adoptSession: async (candidate) => {
      const session = await adoptSessionCore(
        ctx,
        candidate,
        opts?.getExternalCandidates ? { listCandidates: opts.getExternalCandidates } : {}
      );
      return toSummary(session);
    },

    // deleteSessionCore internally translates an adopted session to detach-only
    // (never kills the foreign tmux session) — see route-helpers.ts.
    stopSession: (id) => deleteSessionCore(ctx, id, true),

    writeInput: (id, data, seq, cid) => {
      const s = getSessionOrThrow(ctx, id);
      // At-most-once: skip stale/duplicate redeliveries when the caller supplies seq+cid.
      if (cid != null && seq != null && !s.shouldApplyInput(cid, seq)) return;
      s.write(data);
    },

    // Session.resize narrows viewportType to ResizeViewportType ('mobile'|'tablet'|'desktop');
    // the fleet wire contract keeps it as a plain string so this module doesn't leak Session's
    // internal type to remote callers. Cast at the boundary; Session ignores unrecognized values.
    resize: (id, cols, rows, opts) =>
      getSessionOrThrow(ctx, id).resize(cols, rows, opts as Parameters<Session['resize']>[2]),

    subscribeTerminal: (id, sink) => {
      const s = getSessionOrThrow(ctx, id);
      const onData = (d: string) => sink({ kind: 'data', data: d });
      const onClear = () => sink({ kind: 'clear' });
      const onRefresh = () => sink({ kind: 'refresh' });
      s.on('terminal', onData);
      s.on('clearTerminal', onClear);
      s.on('needsRefresh', onRefresh);
      return () => {
        s.off('terminal', onData);
        s.off('clearTerminal', onClear);
        s.off('needsRefresh', onRefresh);
      };
    },

    getTerminalBuffer: (id) => readSessionTerminalBuffer(ctx, id),

    listResumeCandidates: async () => {
      const { sessions } = await listHistorySessions();
      return sessions.map(historySessionToResumeCandidate);
    },

    listDirs: async (path) => listDirsSafe(path),
  };
}

function getSessionOrThrow(ctx: SessionCoreCtx, id: string): Session {
  const s = ctx.sessions.get(id);
  if (!s) throw new Error('Session not found');
  return s;
}

/**
 * Map a Session's live status to the fleet wire status.
 *
 * SessionStatus (../types/session.ts) and FleetSessionStatus (./protocol.ts)
 * are currently the same union ('idle' | 'busy' | 'stopped' | 'error'), so this
 * is an explicit identity switch rather than a cast — it stays correct if either
 * union drifts, and any truly unknown value falls back to 'idle' (an exited
 * process is already reflected as Session status 'stopped', not as "unknown").
 */
export function sessionStatusForFleet(session: Session): FleetSessionStatus {
  switch (session.status) {
    case 'idle':
      return 'idle';
    case 'busy':
      return 'busy';
    case 'stopped':
      return 'stopped';
    case 'error':
      return 'error';
    default:
      return 'idle';
  }
}
