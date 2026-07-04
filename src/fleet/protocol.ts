/**
 * @fileoverview Fleet protocol — shared types, zod schemas, and Tab mapping.
 *
 * This is the wire protocol between a node agent (running on a remote machine,
 * e.g. macmini) and the central controller (this server). It is imported by
 * every later fleet task: device registry, node WS endpoint, node agent,
 * central controller, REST API, and the frontend dashboard.
 *
 * Key exports:
 * - FLEET_PROTOCOL_VERSION — wire protocol version (bump on breaking changes)
 * - FleetDeviceStatus / FleetSessionStatus / FleetSessionMode — status/mode unions
 *   (FleetSessionMode intentionally mirrors SessionMode in ../types/session.ts:44)
 * - FleetCapabilities / FleetDeviceSummary / FleetDeviceJoinInfo — device shapes
 * - FleetSessionSummary / FleetSessionTab / CreateFleetSessionRequest — session shapes
 * - FleetDashboardState — aggregate state served by `GET /api/fleet`
 * - NodeToCentralFrame / CentralToNodeFrame — the two WebSocket frame unions
 * - *Schema zod schemas for every type above, plus parseNodeToCentralFrame /
 *   parseCentralToNodeFrame for safe (never-throw) frame decoding
 * - buildFleetSessionTab — derives a FleetSessionTab from a device + session
 */

import { basename } from 'node:path';
import { z } from 'zod';

/** Fleet wire protocol version. Bump on breaking frame-shape changes. */
export const FLEET_PROTOCOL_VERSION = 1;

/** Device connectivity status as seen by the central controller. */
export type FleetDeviceStatus = 'online' | 'offline';

/** Session lifecycle status (mirrors SessionStatus in ../types/session.ts). */
export type FleetSessionStatus = 'idle' | 'busy' | 'stopped' | 'error';

/** Session CLI backend mode (aligned with SessionMode in ../types/session.ts:44). */
export type FleetSessionMode = 'claude' | 'shell' | 'opencode' | 'codex' | 'gemini';

/** Which CLI backends / features a node device supports. */
export interface FleetCapabilities {
  tmux: boolean;
  claude: boolean;
  codex: boolean;
  shell: boolean;
}

/** Full device record as tracked by the central controller. */
export interface FleetDeviceSummary {
  id: string;
  name: string;
  hostname: string;
  platform: string;
  arch: string;
  username: string;
  version: string;
  status: FleetDeviceStatus;
  lastSeenAt: number;
  activeSessionCount: number;
  capabilities: FleetCapabilities;
}

/** Static device identity sent by a node during `hello`; FleetDeviceSummary minus the fields the controller derives. */
export interface FleetDeviceJoinInfo {
  name: string;
  hostname: string;
  platform: string;
  arch: string;
  username: string;
  version: string;
  capabilities: FleetCapabilities;
}

/** A single remote session as reported by a node device. */
export interface FleetSessionSummary {
  deviceId: string;
  id: string;
  name?: string;
  mode: FleetSessionMode;
  status: FleetSessionStatus;
  workingDir: string;
  pid: number | null;
  createdAt: number;
  lastActivityAt: number;
  /**
   * True when this session ADOPTED a foreign (user-owned) tmux session (Rev5
   * §13.2 / Task 28). Codeman only attaches to it — the tab is detach-only and
   * must never expose a stop/kill affordance. Absent/false for normal sessions.
   */
  adopted?: boolean;
}

/** Derived UI tab for a device+session pair, used to key/label a split-grid terminal. */
export interface FleetSessionTab {
  key: string;
  deviceId: string;
  sessionId: string;
  deviceName: string;
  sessionLabel: string;
  title: string;
  mode: FleetSessionMode;
  status: FleetSessionStatus;
  workingDir: string;
}

/** Payload for creating a new session on a remote device. */
export interface CreateFleetSessionRequest {
  workingDir: string;
  mode?: FleetSessionMode;
  name?: string;
  prompt?: string;
  /** Resume an existing Claude conversation by its sessionId (claude mode only; passed to createSessionCore). */
  resumeSessionId?: string;
}

/**
 * A resumable past conversation on a device, derived from the same core listing
 * logic behind `GET /api/history/sessions` (session-routes.ts). Returned by the
 * `list-resume-candidates` RPC and `GET /api/fleet/devices/:deviceId/resume-candidates`.
 */
export interface ResumeCandidate {
  sessionId: string;
  workingDir: string;
  title: string;
  updatedAt: number;
  projectKey?: string;
}

/**
 * An AI-CLI session discovered running inside a FOREIGN tmux server (i.e. one
 * the user started themselves, not a Codeman-owned session on our own socket).
 * Produced by `ExternalSessionScanner` (external-session-scanner.ts) on each
 * node (and the central's own machine), reported up via the `external-sessions`
 * frame, and cached per-device by the central controller. Task 28 turns a
 * candidate into an adopted read/write tab; discovery (this) is read-only.
 */
export interface ExternalSessionCandidate {
  /** tmux socket name the session lives on; '' = the user's default tmux server (no `-L`). */
  socket: string;
  /** tmux session name (`#{session_name}`). */
  tmuxSession: string;
  /** Which AI CLI is running in the pane's process tree. */
  mode: FleetSessionMode;
  /** The matching pane's current working directory (`#{pane_current_path}`). */
  workingDir: string;
  /** When this candidate was first observed (stable across scans while it persists). */
  firstSeenAt: number;
}

/** Aggregate fleet state served by `GET /api/fleet`. */
export interface FleetDashboardState {
  devices: FleetDeviceSummary[];
  sessions: FleetSessionSummary[];
  sessionTabs: FleetSessionTab[];
  generatedAt: number;
}

/** Frames a node agent sends to the central controller over its WebSocket connection. */
export type NodeToCentralFrame =
  | { t: 'hello'; protocol: 1; device: FleetDeviceSummary; sessions: FleetSessionSummary[] }
  | { t: 'heartbeat'; sessions: FleetSessionSummary[] }
  | { t: 'session:update'; session: FleetSessionSummary }
  | { t: 'external-sessions'; candidates: ExternalSessionCandidate[] }
  | { t: 'terminal:data'; sessionId: string; data: string }
  | { t: 'terminal:clear'; sessionId: string }
  | { t: 'terminal:refresh'; sessionId: string } // signal only, buffer is fetched via get-buffer RPC
  | { t: 'ack'; requestId: string; data?: unknown }
  | { t: 'error'; requestId?: string; message: string };

/** Frames the central controller sends to a node agent over its WebSocket connection. */
export type CentralToNodeFrame =
  | { t: 'list-sessions'; requestId: string }
  | { t: 'create-session'; requestId: string; payload: CreateFleetSessionRequest }
  | { t: 'stop-session'; requestId: string; sessionId: string }
  | { t: 'get-buffer'; requestId: string; sessionId: string }
  | { t: 'list-resume-candidates'; requestId: string }
  | { t: 'list-dirs'; requestId: string; path: string }
  | { t: 'get-system-stats'; requestId: string }
  | { t: 'terminal:subscribe'; requestId: string; sessionId: string }
  | { t: 'terminal:unsubscribe'; requestId: string; sessionId: string }
  | { t: 'terminal:input'; sessionId: string; data: string; seq?: number; cid?: string }
  | { t: 'terminal:resize'; sessionId: string; cols: number; rows: number; viewportType?: string; force?: boolean }
  | { t: 'adopt-session'; requestId: string; candidate: ExternalSessionCandidate };

// ========== zod schemas ==========

const FleetDeviceStatusSchema: z.ZodType<FleetDeviceStatus> = z.enum(['online', 'offline']);

const FleetSessionStatusSchema: z.ZodType<FleetSessionStatus> = z.enum(['idle', 'busy', 'stopped', 'error']);

const FleetSessionModeSchema: z.ZodType<FleetSessionMode> = z.enum(['claude', 'shell', 'opencode', 'codex', 'gemini']);

const FleetCapabilitiesSchema: z.ZodType<FleetCapabilities> = z.object({
  tmux: z.boolean(),
  claude: z.boolean(),
  codex: z.boolean(),
  shell: z.boolean(),
});

const FleetDeviceSummarySchema: z.ZodType<FleetDeviceSummary> = z.object({
  id: z.string(),
  name: z.string(),
  hostname: z.string(),
  platform: z.string(),
  arch: z.string(),
  username: z.string(),
  version: z.string(),
  status: FleetDeviceStatusSchema,
  lastSeenAt: z.number(),
  activeSessionCount: z.number(),
  capabilities: FleetCapabilitiesSchema,
});

/** = FleetDeviceSummary minus the fields the controller derives (id/status/lastSeenAt/activeSessionCount). */
export const FleetDeviceJoinInfoSchema: z.ZodType<FleetDeviceJoinInfo> = z.object({
  name: z.string(),
  hostname: z.string(),
  platform: z.string(),
  arch: z.string(),
  username: z.string(),
  version: z.string(),
  capabilities: FleetCapabilitiesSchema,
});

const FleetSessionSummarySchema: z.ZodType<FleetSessionSummary> = z.object({
  deviceId: z.string(),
  id: z.string(),
  name: z.string().optional(),
  mode: FleetSessionModeSchema,
  status: FleetSessionStatusSchema,
  workingDir: z.string(),
  pid: z.number().nullable(),
  createdAt: z.number(),
  lastActivityAt: z.number(),
  adopted: z.boolean().optional(),
});

export const CreateFleetSessionRequestSchema: z.ZodType<CreateFleetSessionRequest> = z.object({
  workingDir: z.string().min(1),
  mode: FleetSessionModeSchema.optional(),
  name: z.string().optional(),
  prompt: z.string().optional(),
  resumeSessionId: z.string().optional(),
});

export const ExternalSessionCandidateSchema: z.ZodType<ExternalSessionCandidate> = z.object({
  socket: z.string(),
  tmuxSession: z.string(),
  mode: FleetSessionModeSchema,
  workingDir: z.string(),
  firstSeenAt: z.number(),
});

export const ResumeCandidateSchema: z.ZodType<ResumeCandidate> = z.object({
  sessionId: z.string(),
  workingDir: z.string(),
  title: z.string(),
  updatedAt: z.number(),
  projectKey: z.string().optional(),
});

export const NodeToCentralFrameSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('hello'),
    protocol: z.literal(1),
    device: FleetDeviceSummarySchema,
    sessions: z.array(FleetSessionSummarySchema),
  }),
  z.object({
    t: z.literal('heartbeat'),
    sessions: z.array(FleetSessionSummarySchema),
  }),
  z.object({
    t: z.literal('session:update'),
    session: FleetSessionSummarySchema,
  }),
  z.object({
    t: z.literal('external-sessions'),
    candidates: z.array(ExternalSessionCandidateSchema),
  }),
  z.object({
    t: z.literal('terminal:data'),
    sessionId: z.string(),
    data: z.string(),
  }),
  z.object({
    t: z.literal('terminal:clear'),
    sessionId: z.string(),
  }),
  z.object({
    t: z.literal('terminal:refresh'),
    sessionId: z.string(),
  }),
  z.object({
    t: z.literal('ack'),
    requestId: z.string(),
    data: z.unknown().optional(),
  }),
  z.object({
    t: z.literal('error'),
    requestId: z.string().optional(),
    message: z.string(),
  }),
]);

export const CentralToNodeFrameSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('list-sessions'),
    requestId: z.string(),
  }),
  z.object({
    t: z.literal('create-session'),
    requestId: z.string(),
    payload: CreateFleetSessionRequestSchema,
  }),
  z.object({
    t: z.literal('stop-session'),
    requestId: z.string(),
    sessionId: z.string(),
  }),
  z.object({
    t: z.literal('get-buffer'),
    requestId: z.string(),
    sessionId: z.string(),
  }),
  z.object({
    t: z.literal('list-resume-candidates'),
    requestId: z.string(),
  }),
  z.object({
    t: z.literal('list-dirs'),
    requestId: z.string(),
    path: z.string(),
  }),
  z.object({
    t: z.literal('get-system-stats'),
    requestId: z.string(),
  }),
  z.object({
    t: z.literal('terminal:subscribe'),
    requestId: z.string(),
    sessionId: z.string(),
  }),
  z.object({
    t: z.literal('terminal:unsubscribe'),
    requestId: z.string(),
    sessionId: z.string(),
  }),
  z.object({
    t: z.literal('terminal:input'),
    sessionId: z.string(),
    data: z.string(),
    seq: z.number().optional(),
    cid: z.string().optional(),
  }),
  z.object({
    t: z.literal('terminal:resize'),
    sessionId: z.string(),
    cols: z.number(),
    rows: z.number(),
    viewportType: z.string().optional(),
    force: z.boolean().optional(),
  }),
  z.object({
    t: z.literal('adopt-session'),
    requestId: z.string(),
    candidate: ExternalSessionCandidateSchema,
  }),
]);

// ========== safe frame parsing ==========

/** Parse a raw string (JSON) or object into a NodeToCentralFrame; never throws, returns null on any failure. */
export function parseNodeToCentralFrame(raw: unknown): NodeToCentralFrame | null {
  return parseFrame(NodeToCentralFrameSchema, raw);
}

/** Parse a raw string (JSON) or object into a CentralToNodeFrame; never throws, returns null on any failure. */
export function parseCentralToNodeFrame(raw: unknown): CentralToNodeFrame | null {
  return parseFrame(CentralToNodeFrameSchema, raw);
}

function parseFrame<T>(schema: z.ZodType<T>, raw: unknown): T | null {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}

// ========== Tab mapping ==========

/** Derive a FleetSessionTab from a device + session, applying name fallback rules. */
export function buildFleetSessionTab(device: FleetDeviceSummary, session: FleetSessionSummary): FleetSessionTab {
  const deviceName = device.name || device.hostname || device.id.slice(0, 8);
  const sessionLabel = session.name || basename(session.workingDir) || session.id.slice(0, 8);
  return {
    key: `${session.deviceId}:${session.id}`,
    deviceId: session.deviceId,
    sessionId: session.id,
    deviceName,
    sessionLabel,
    title: `${deviceName} / ${sessionLabel}`,
    mode: session.mode,
    status: session.status,
    workingDir: session.workingDir,
  };
}
