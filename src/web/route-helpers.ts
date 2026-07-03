/**
 * @fileoverview Shared helper functions for route modules.
 *
 * Contains pure functions extracted from server.ts and a session lookup helper
 * that replaces ~43 inline not-found checks across route handlers.
 */

import { join, resolve, relative, isAbsolute } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import type { z } from 'zod';
import { Session, isAltScreenStripMode } from '../session.js';
import {
  ApiErrorCode,
  createErrorResponse,
  httpStatusForErrorCode,
  type SessionMode,
  type OpenCodeConfig,
  type CodexConfig,
  type GeminiConfig,
  type EffortLevel,
} from '../types.js';
import { parseRalphLoopConfig, extractCompletionPhrase } from '../ralph-config.js';
import { SseEvent } from './sse-events.js';
import type { SessionPort } from './ports/session-port.js';
import type { EventPort } from './ports/event-port.js';
import type { ConfigPort } from './ports/config-port.js';
import type { InfraPort } from './ports/infra-port.js';
import type { AuthPort } from './ports/auth-port.js';
import { dataPath } from '../config/instance.js';
import { getLifecycleLog } from '../session-lifecycle-log.js';
import { MAX_CONCURRENT_SESSIONS } from '../config/map-limits.js';

// Shared path constants used across route modules. CASES_DIR (project folders)
// stays shared across instances; SETTINGS_PATH is per-instance runtime state.
export const CASES_DIR = join(homedir(), 'codeman-cases');
export const SETTINGS_PATH = dataPath('settings.json');

// Pre-compiled regex for terminal buffer cleaning (avoids per-request compilation)
// eslint-disable-next-line no-control-regex
const CLAUDE_BANNER_PATTERN = /\x1b\[1mClaud/;
// eslint-disable-next-line no-control-regex
const CTRL_L_PATTERN = /\x0c/g;
const LEADING_WHITESPACE_PATTERN = /^[\s\r\n]+/;

/**
 * Match xterm alternate-screen mode toggles + the standalone scrollback-erase.
 *
 * - DECSET/DECRST 47, 1047, 1049 = enter/exit alternate screen buffer
 *   (1049 also saves cursor and clears the alt buffer).
 * - CSI 3 J = erase saved lines (scrollback).
 *
 * Codex AND Claude Code emit `\x1b[?1049h` and clear-scrollback sequences (the
 * latter intermittently, e.g. full-screen pickers/dialogs). xterm.js obeys them
 * by switching to the alt buffer (no native scrollback) and wiping saved lines,
 * so the user's conversation history disappears on every tab switch / pane
 * refresh (and scroll-up breaks live). Stripping these from the replayed byte
 * stream keeps everything in the main buffer with scrollback intact. Mirrors the
 * live-stream strip in Session._handleTerminalOutput (isAltScreenStripMode).
 */
// eslint-disable-next-line no-control-regex
const ALT_SCREEN_TOGGLE_PATTERN = /\x1b\[\?(?:47|1047|1049)[hl]/g;
// eslint-disable-next-line no-control-regex
const ERASE_SCROLLBACK_PATTERN = /\x1b\[3J/g;
// Mouse-tracking enables (X10/button/any-event/UTF-8/SGR/alt-scroll) — once on,
// xterm.js forwards wheel events to the app instead of scrolling the viewport.
// Live streams are stripped at the source, but buffers persisted BEFORE that
// strip existed can still carry them; strip on replay for parity.
// eslint-disable-next-line no-control-regex
const MOUSE_TRACKING_PATTERN = /\x1b\[\?(?:1000|1001|1002|1003|1005|1006|1007)[hl]/g;

/**
 * Strip redundant Ink spinner/status-bar redraw frames from the terminal buffer.
 * Ink (Claude Code's TUI) uses absolute cursor positioning (CSI n d = VPA) to animate
 * the spinner and update the status bar. During long thinking phases, these frames
 * accumulate to 500KB+ of repeated overwrites to the same rows.
 *
 * Strategy: detect "redraw clusters" — dense runs of VPA escapes where each is within
 * FRAME_GAP bytes of the previous (i.e. continuous rerendering of the same UI region).
 * Collapse each big cluster down to just the bytes from its last VPA onwards (the final
 * frame). Content *between* clusters (Claude's streamed response text) is preserved.
 *
 * Without clustering, a single first-VPA-finds-all approach would discard the entire
 * conversation after Claude's first render — losing 100KB+ of legitimate scrollback.
 */
export function stripInkRedrawBloat(buffer: string): string {
  // eslint-disable-next-line no-control-regex
  const vpaRe = /\x1b\[\d+d/g;
  const positions: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = vpaRe.exec(buffer)) !== null) {
    positions.push(m.index);
  }
  if (positions.length < 10) return buffer; // Too few VPAs to be bloat

  // Group consecutive VPAs into clusters separated by gaps > FRAME_GAP.
  // Within a cluster, VPAs are close together (continuous rerenders).
  // Between clusters, real terminal output (response text) lives.
  const FRAME_GAP = 8 * 1024; // 8KB — one Ink frame is typically 1-4KB
  const MIN_BLOAT_SIZE = 32 * 1024; // Only collapse clusters spanning >= 32KB

  const clusters: { start: number; end: number }[] = [];
  let cs = positions[0];
  let ce = positions[0];
  for (let i = 1; i < positions.length; i++) {
    if (positions[i] - ce <= FRAME_GAP) {
      ce = positions[i];
    } else {
      clusters.push({ start: cs, end: ce });
      cs = positions[i];
      ce = positions[i];
    }
  }
  clusters.push({ start: cs, end: ce });

  // For each big cluster, replace [start..end] with the bytes from `end` onwards
  // (which contains the last frame's content up to where the next cluster, or
  // post-cluster content, begins).
  const parts: string[] = [];
  let cursor = 0;
  for (const cl of clusters) {
    if (cl.end - cl.start < MIN_BLOAT_SIZE) continue;
    parts.push(buffer.slice(cursor, cl.start));
    cursor = cl.end;
  }
  parts.push(buffer.slice(cursor));
  return parts.join('');
}

/**
 * Validates that a path component doesn't escape the base directory.
 * Returns the resolved full path, or null if the path is a traversal attempt.
 */
export function validatePathWithinBase(name: string, baseDir: string): string | null {
  const fullPath = resolve(join(baseDir, name));
  const resolvedBase = resolve(baseDir);
  const relPath = relative(resolvedBase, fullPath);
  if (relPath.startsWith('..') || isAbsolute(relPath)) {
    return null;
  }
  return fullPath;
}

/**
 * Reads and parses a JSON config file, returning a default value on ENOENT.
 * Logs an error for any I/O failure other than a missing file.
 */
export async function readJsonConfig<T>(filePath: string, logLabel: string, defaultValue: T): Promise<T> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`Failed to read ${logLabel}:`, err);
    }
    return defaultValue;
  }
}

/**
 * Validates that a file path (possibly containing symlinks) resolves to a location
 * within the given session working directory. Returns the resolved and relative paths,
 * or null if the path escapes the directory or doesn't exist.
 */
export function validateSessionFilePath(
  sessionWorkingDir: string,
  filePath: string
): { resolvedPath: string; relativePath: string } | null {
  const fullPath = resolve(sessionWorkingDir, filePath);
  let resolvedPath: string;
  try {
    resolvedPath = realpathSync(fullPath);
  } catch {
    return null;
  }
  const relativePath = relative(sessionWorkingDir, resolvedPath);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return null;
  }
  return { resolvedPath, relativePath };
}

// Maximum hook data size (prevents oversized SSE broadcasts)
const MAX_HOOK_DATA_SIZE = 8 * 1024;

/**
 * Look up a session by ID or throw a structured error.
 * Replaces the pattern: `const session = sessions.get(id); if (!session) return createErrorResponse(...)`.
 */
export function findSessionOrFail(ctx: SessionPort, sessionId: string): Session {
  const session = ctx.sessions.get(sessionId);
  if (!session) {
    throw Object.assign(new Error(`Session ${sessionId} not found`), {
      statusCode: 404,
      body: createErrorResponse(ApiErrorCode.NOT_FOUND, `Session ${sessionId} not found`),
    });
  }
  return session;
}

/**
 * Parse and validate a request body against a Zod schema, or throw a structured 400 error.
 * Replaces the repeated pattern: `const r = Schema.safeParse(body); if (!r.success) return createErrorResponse(...)`.
 */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown, errorMessage?: string): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const msg = errorMessage ?? result.error.issues[0]?.message ?? 'Validation failed';
    throw Object.assign(new Error(msg), {
      statusCode: 400,
      body: createErrorResponse(ApiErrorCode.INVALID_INPUT, msg),
    });
  }
  return result.data;
}

/**
 * Persist session state and broadcast a SessionUpdated event.
 * Replaces the repeated two-line pattern across route handlers.
 */
export function persistAndBroadcastSession(ctx: SessionPort & EventPort, session: Session): void {
  ctx.persistSessionState(session);
  ctx.broadcast(SseEvent.SessionUpdated, ctx.getSessionStateWithRespawn(session));
}

/**
 * Formats uptime in seconds to a human-readable string (e.g., "1d 2h 30m 15s").
 */
export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);

  return parts.join(' ');
}

/**
 * Sanitizes hook event data before broadcasting via SSE.
 * Extracts only relevant fields and limits total size to prevent
 * oversized payloads from being broadcast to all connected clients.
 */
export function sanitizeHookData(data: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!data || typeof data !== 'object') return {};

  // Only forward known safe fields from Claude Code hook stdin
  const safeFields: Record<string, unknown> = {};
  const allowedKeys = [
    'hook_event_name',
    'tool_name',
    'tool_input',
    'session_id',
    'cwd',
    'permission_mode',
    'stop_hook_active',
    'transcript_path',
  ];

  for (const key of allowedKeys) {
    if (key in data && data[key] !== undefined) {
      safeFields[key] = data[key];
    }
  }

  // For tool_input, extract only summary fields (not full file content)
  if (safeFields.tool_input && typeof safeFields.tool_input === 'object') {
    const input = safeFields.tool_input as Record<string, unknown>;
    const summary: Record<string, unknown> = {};
    if (input.command) summary.command = String(input.command).slice(0, 500);
    if (input.file_path) summary.file_path = String(input.file_path).slice(0, 500);
    if (input.description) summary.description = String(input.description).slice(0, 200);
    if (input.query) summary.query = String(input.query).slice(0, 200);
    if (input.url) summary.url = String(input.url).slice(0, 500);
    if (input.pattern) summary.pattern = String(input.pattern).slice(0, 200);
    if (input.prompt) summary.prompt = String(input.prompt).slice(0, 200);
    safeFields.tool_input = summary;
  }

  // Final size check - drop if serialized data exceeds limit
  const serialized = JSON.stringify(safeFields);
  if (serialized.length > MAX_HOOK_DATA_SIZE) {
    return { tool_name: safeFields.tool_name, _truncated: true };
  }

  return safeFields;
}

/**
 * Toggles a service (watcher/manager) on or off based on an enabled flag.
 * Logs start/stop to console with the given label. Runs an optional callback after starting.
 */
export function toggleService(
  enabled: boolean,
  service: { isRunning(): boolean; start(): void; stop(): void },
  label: string,
  onStart?: () => void
): void {
  if (enabled && !service.isRunning()) {
    service.start();
    onStart?.();
    console.log(`${label} started via settings change`);
  } else if (!enabled && service.isRunning()) {
    service.stop();
    console.log(`${label} stopped via settings change`);
  }
}

/**
 * Auto-configure Ralph tracker for a session.
 *
 * Priority order:
 * 1. .claude/ralph-loop.local.md (official Ralph Wiggum plugin state)
 * 2. CLAUDE.md <promise> tags (fallback)
 *
 * The ralph-loop.local.md file has priority because it contains
 * the exact configuration from an active Ralph loop session.
 */
export function autoConfigureRalph(session: Session, workingDir: string, ctx: EventPort): void {
  // First, try to read the official Ralph Wiggum plugin state file
  const ralphConfig = parseRalphLoopConfig(workingDir);

  if (ralphConfig && ralphConfig.completionPromise) {
    session.ralphTracker.enable();
    session.ralphTracker.startLoop(ralphConfig.completionPromise, ralphConfig.maxIterations ?? undefined);

    // Restore iteration count if available
    if (ralphConfig.iteration > 0) {
      // The tracker's cycleCount will be updated when we detect iteration patterns
      // in the terminal output, but we can set maxIterations now
      console.log(`[auto-detect] Ralph loop at iteration ${ralphConfig.iteration}/${ralphConfig.maxIterations ?? '∞'}`);
    }

    console.log(
      `[auto-detect] Configured Ralph loop for session ${session.id} from ralph-loop.local.md: ${ralphConfig.completionPromise}`
    );
    ctx.broadcast(SseEvent.SessionRalphLoopUpdate, {
      sessionId: session.id,
      state: session.ralphTracker.loopState,
    });
    return;
  }

  // Fallback: try CLAUDE.md
  const claudeMdPath = join(workingDir, 'CLAUDE.md');
  const completionPhrase = extractCompletionPhrase(claudeMdPath);

  if (completionPhrase) {
    session.ralphTracker.enable();
    session.ralphTracker.startLoop(completionPhrase);
    console.log(`[auto-detect] Configured Ralph loop for session ${session.id} from CLAUDE.md: ${completionPhrase}`);
    ctx.broadcast(SseEvent.SessionRalphLoopUpdate, {
      sessionId: session.id,
      state: session.ralphTracker.loopState,
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// Session lifecycle core — shared by the REST routes below AND (from Task 7
// onward) fleet's local device adapter, so both paths create/destroy/read
// sessions through one implementation instead of forking the logic.
// ═══════════════════════════════════════════════════════════════

/** Capability set the session-lifecycle core functions depend on — the same
 * port intersection `registerSessionRoutes` uses. */
export type SessionCoreCtx = SessionPort & EventPort & ConfigPort & InfraPort & AuthPort;

/** Throws a structured `{statusCode, body}` error, same convention as
 * `findSessionOrFail` / `parseBody` above (rendered by the shared Fastify
 * error handler in route-error-handler.ts). */
function throwApiError(code: ApiErrorCode, message: string): never {
  throw Object.assign(new Error(message), {
    statusCode: httpStatusForErrorCode(code),
    body: createErrorResponse(code, message),
  });
}

export interface CreateSessionCoreInput {
  workingDir: string;
  mode?: SessionMode;
  name?: string;
  openCodeConfig?: OpenCodeConfig;
  codexConfig?: CodexConfig;
  geminiConfig?: GeminiConfig;
  resumeSessionId?: string;
  envOverrides?: Record<string, string>;
  effort?: EffortLevel;
}

/**
 * Create (and optionally start) a session. Reused by POST /api/sessions and
 * fleet's device adapter.
 *
 * Mirrors the original POST /api/sessions handler's session-mechanics: the
 * MAX_CONCURRENT_SESSIONS cap and workingDir directory check are duplicated
 * here AND in the REST handler (route-helpers callers get a real guard even
 * without a handler in front of them) — the REST handler still checks first,
 * before its own disk side-effects (env override stripping, model override /
 * statusLine writes), so a request that will be rejected here never performs
 * those writes. The re-check here is then a cheap no-op for the REST path.
 *
 * `opts.start` is fleet-only: REST's POST /api/sessions never passes it —
 * REST sessions are started later via the separate /interactive or /shell
 * endpoints, unchanged. When set, this calls `startShell()` for shell mode
 * or `startInteractive()` otherwise (fleet sessions are always interactive).
 */
export async function createSessionCore(
  ctx: SessionCoreCtx,
  input: CreateSessionCoreInput,
  opts?: { start?: boolean }
): Promise<Session> {
  // Prevent unbounded session creation
  if (ctx.sessions.size >= MAX_CONCURRENT_SESSIONS) {
    throwApiError(
      ApiErrorCode.OPERATION_FAILED,
      `Maximum concurrent sessions (${MAX_CONCURRENT_SESSIONS}) reached. Delete some sessions first.`
    );
  }

  // Validate workingDir exists and is a directory
  let dirStat: ReturnType<typeof statSync>;
  try {
    dirStat = statSync(input.workingDir);
  } catch {
    throwApiError(ApiErrorCode.INVALID_INPUT, 'workingDir does not exist');
  }
  if (!dirStat.isDirectory()) {
    throwApiError(ApiErrorCode.INVALID_INPUT, 'workingDir is not a directory');
  }

  const mode = input.mode || 'claude';

  // Check OpenCode availability if requested
  if (mode === 'opencode') {
    const { isOpenCodeAvailable } = await import('../utils/opencode-cli-resolver.js');
    if (!isOpenCodeAvailable()) {
      throwApiError(
        ApiErrorCode.OPERATION_FAILED,
        'OpenCode CLI not found. Install with: curl -fsSL https://opencode.ai/install | bash'
      );
    }
  }

  // Check Codex availability if requested
  if (mode === 'codex') {
    const { isCodexAvailable } = await import('../utils/codex-cli-resolver.js');
    if (!isCodexAvailable()) {
      throwApiError(ApiErrorCode.OPERATION_FAILED, 'Codex CLI not found. Install with: npm install -g @openai/codex');
    }
  }

  // Check Gemini availability if requested
  if (mode === 'gemini') {
    const { isGeminiAvailable } = await import('../utils/gemini-cli-resolver.js');
    if (!isGeminiAvailable()) {
      throwApiError(
        ApiErrorCode.OPERATION_FAILED,
        'Gemini CLI not found. Install with: npm install -g @google/gemini-cli'
      );
    }
  }

  const globalNice = await ctx.getGlobalNiceConfig();
  const modelConfig = await ctx.getModelConfig();
  const model =
    mode === 'opencode'
      ? input.openCodeConfig?.model
      : mode === 'codex'
        ? input.codexConfig?.model
        : mode === 'gemini'
          ? input.geminiConfig?.model
          : mode !== 'shell'
            ? modelConfig?.defaultModel || undefined
            : undefined;
  const claudeModeConfig = await ctx.getClaudeModeConfig();
  const terminalHistoryConfig = await ctx.getTerminalHistoryConfig();
  const session = new Session({
    workingDir: input.workingDir,
    mode,
    name: input.name || '',
    mux: ctx.mux,
    useMux: true,
    niceConfig: globalNice,
    model,
    claudeMode: claudeModeConfig.claudeMode,
    allowedTools: claudeModeConfig.allowedTools,
    openCodeConfig: mode === 'opencode' ? input.openCodeConfig : undefined,
    codexConfig: mode === 'codex' ? input.codexConfig : undefined,
    geminiConfig: mode === 'gemini' ? input.geminiConfig : undefined,
    resumeSessionId: input.resumeSessionId,
    envOverrides: input.envOverrides,
    effort: input.effort,
    tmuxHistoryLimit: terminalHistoryConfig.tmuxHistoryLimit,
  });

  ctx.addSession(session);
  ctx.store.incrementSessionsCreated();
  ctx.persistSessionState(session);
  await ctx.setupSessionListeners(session);
  getLifecycleLog().log({ event: 'created', sessionId: session.id, name: session.name });

  // Use light state for broadcast — buffers are fetched on-demand via /terminal.
  // Avoids serializing 2-3MB of terminal+text buffers per session creation.
  const lightState = ctx.getSessionStateWithRespawn(session);
  ctx.broadcast(SseEvent.SessionCreated, lightState);

  if (opts?.start) {
    if (mode === 'shell') {
      await session.startShell();
    } else {
      await session.startInteractive();
    }
  }

  return session;
}

/**
 * Delete a session (tears down its mux pane/process and internal state).
 * Reused by DELETE /api/sessions/:id and fleet's device adapter.
 */
export async function deleteSessionCore(ctx: SessionPort, sessionId: string, killMux: boolean = true): Promise<void> {
  const session = ctx.sessions.get(sessionId);
  if (!session) {
    throwApiError(ApiErrorCode.NOT_FOUND, 'Session not found');
  }
  // Adopted (foreign-tmux) sessions are DETACH-ONLY (Rev5 §13.2): force
  // killMux=false so cleanupSession never kills the foreign session, never
  // touches its workspace, and never removes persisted state — it just detaches
  // the attach PTY (Session.stop still kills the attach client for adopted
  // sessions regardless of killMux) and drops the session from ctx.sessions.
  const effectiveKillMux = session.isAdopted ? false : killMux;
  await ctx.cleanupSession(sessionId, effectiveKillMux, session.isAdopted ? 'user_detach' : 'user_delete');
}

/**
 * Rebuild the replayable terminal buffer for a session: prepends the live
 * tmux pane buffer (so tab-switch replay shows the current on-screen frame),
 * strips Ink spinner/status-bar redraw bloat, strips alt-screen toggles /
 * scrollback-erase / mouse-tracking escapes for TUI modes, then optionally
 * tails to the last `tailBytes` bytes. Returns full detail (used by the
 * GET /api/sessions/:id/terminal handler); `readSessionTerminalBuffer` below
 * wraps this for callers (e.g. fleet) that only need the buffer text.
 */
export function computeSessionTerminalBuffer(
  ctx: Pick<InfraPort, 'mux'>,
  session: Session,
  tailBytes: number
): { terminalBuffer: string; fullSize: number; truncated: boolean } {
  // Prepend the live tmux pane buffer so tab-switch replay shows the current
  // on-screen frame, not just the accumulated byte history. This matters for
  // TUI modes (codex/opencode) that repaint only their latest frame: the
  // accumulated buffer alone replays as the idle banner. We clear the viewport
  // (`\x1b[H\x1b[2J`) between the history and the live pane so they don't
  // overlap. `captureActivePaneBuffer` is a no-op ('') under test mode and
  // returns null when unavailable, in which case we fall back to history.
  const muxName = session.muxName;
  const liveMuxBuffer =
    muxName && typeof ctx.mux.captureActivePaneBuffer === 'function' ? ctx.mux.captureActivePaneBuffer(muxName) : null;
  const rawBuffer =
    liveMuxBuffer !== null && liveMuxBuffer.length > 0
      ? session.terminalBufferLength > 0
        ? `${session.terminalBuffer}\x1b[H\x1b[2J${liveMuxBuffer}`
        : liveMuxBuffer
      : session.terminalBuffer;
  const fullSize = rawBuffer.length;
  let truncated = false;
  let cleanBuffer: string;

  // Strip redundant Ink spinner/status redraws BEFORE tailing.
  // During long thinking phases, Ink rewrites the same rows thousands of times
  // (500KB+). Without stripping, tail mode returns only spinner frames and
  // the terminal appears empty when switching tabs.
  let strippedBuffer = stripInkRedrawBloat(rawBuffer);

  // Strip alt-screen toggles and scrollback-erase from Codex/Claude byte
  // streams. xterm.js obeys them by switching to its scrollback-less alt
  // buffer and wiping saved lines, so conversation history disappears on tab
  // switch. Same gate as the live-stream strip in session.ts.
  if (isAltScreenStripMode(session.mode)) {
    strippedBuffer = strippedBuffer
      .replace(ALT_SCREEN_TOGGLE_PATTERN, '')
      .replace(ERASE_SCROLLBACK_PATTERN, '')
      .replace(MOUSE_TRACKING_PATTERN, '');
  }

  if (tailBytes > 0 && strippedBuffer.length > tailBytes) {
    // Fast path: tail from the end, skip expensive banner search on full 2MB buffer.
    // Banner is near the top and gets discarded by tail anyway.
    cleanBuffer = strippedBuffer.slice(-tailBytes);
    truncated = true;
    // Avoid starting mid-ANSI-escape: find first newline within the first 4KB
    // and start from there. This prevents xterm.js from parsing a partial escape
    // sequence which corrupts cursor position for all subsequent Ink redraws.
    const firstNewline = cleanBuffer.indexOf('\n');
    if (firstNewline > 0 && firstNewline < 4096) {
      cleanBuffer = cleanBuffer.slice(firstNewline + 1);
    }
  } else {
    // Full buffer: clean junk before actual Claude content
    cleanBuffer = strippedBuffer;

    // Find where Claude banner starts (has color codes before "Claude")
    const claudeMatch = cleanBuffer.match(CLAUDE_BANNER_PATTERN);
    if (claudeMatch && claudeMatch.index !== undefined && claudeMatch.index > 0) {
      let lineStart = claudeMatch.index;
      while (lineStart > 0 && cleanBuffer[lineStart - 1] !== '\n') {
        lineStart--;
      }
      cleanBuffer = cleanBuffer.slice(lineStart);
    }
  }

  // Remove Ctrl+L and leading whitespace (cheap on tailed subset)
  cleanBuffer = cleanBuffer.replace(CTRL_L_PATTERN, '').replace(LEADING_WHITESPACE_PATTERN, '');

  return { terminalBuffer: cleanBuffer, fullSize, truncated };
}

/**
 * Read a session's replayable terminal buffer as a plain string. Thin wrapper
 * around `computeSessionTerminalBuffer` for callers (fleet) that don't need
 * the HTTP-only `fullSize`/`truncated` metadata GET /api/sessions/:id/terminal
 * returns alongside it.
 */
export async function readSessionTerminalBuffer(
  ctx: SessionCoreCtx,
  sessionId: string,
  tail?: number
): Promise<string> {
  const session = findSessionOrFail(ctx, sessionId);
  return computeSessionTerminalBuffer(ctx, session, tail ?? 0).terminalBuffer;
}
