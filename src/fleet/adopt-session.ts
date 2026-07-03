/**
 * @fileoverview adoptSessionCore — turn a discovered external tmux session
 * (Rev5 §13.2 / Task 28) into a first-class, detach-only Codeman session.
 *
 * An ADOPTED session wraps a FOREIGN (user-owned) tmux session in the existing
 * `Session` abstraction so the whole fleet pipeline (terminal WS, buffer, input,
 * resize, tabs) works unchanged — but Codeman may only ATTACH to it, never take
 * over its lifecycle. The hard safety rails live on `Session` itself
 * (`externalHost` → detach-only stop, no `mux.killSession`, no automation) and
 * in server.ts (`isAdopted` guards on persist / workspace cleanup); this helper
 * just constructs, registers, and starts the attach — the mirror of Task 6's
 * `createSessionCore`, minus persistence (adopted sessions are intentionally not
 * persisted across restarts: discovery re-finds them and re-adoption is one click).
 *
 * Key export: adoptSessionCore
 */

import { Session } from '../session.js';
import { SseEvent } from '../web/sse-events.js';
import type { SessionCoreCtx } from '../web/route-helpers.js';
import { getLifecycleLog } from '../session-lifecycle-log.js';
import { MAX_CONCURRENT_SESSIONS } from '../config/map-limits.js';
import { ApiErrorCode, createErrorResponse, httpStatusForErrorCode, type SessionMode } from '../types.js';
import type { ExternalSessionCandidate } from './protocol.js';

/** Structured `{statusCode, body}` throw — same convention as route-helpers.ts. */
function throwApiError(code: ApiErrorCode, message: string): never {
  throw Object.assign(new Error(message), {
    statusCode: httpStatusForErrorCode(code),
    body: createErrorResponse(code, message),
  });
}

/** Injectable seams so adoptSessionCore is unit-testable without spawning a real PTY. */
export interface AdoptSessionDeps {
  /**
   * The device's current external-session candidates (its scanner cache). When
   * provided, adoptSessionCore rejects a candidate that has since vanished
   * (matched by socket + tmuxSession). Omit to skip re-validation (e.g. when the
   * central controller has already validated against its own cache).
   */
  listCandidates?: () => ExternalSessionCandidate[];
  /** Session factory — defaults to a real adopted `Session`. Tests inject a mock. */
  buildSession?: (candidate: ExternalSessionCandidate) => Session;
}

/**
 * Default factory: a real `Session` in foreign-tmux attach mode. Maps the
 * candidate onto the adopted-session shape — name `tmux:<session>`, workingDir +
 * mode from the candidate, `externalHost` set (→ detach-only, no mux), `useMux`
 * off. Exported so its mapping is unit-testable without spawning the attach PTY.
 */
export function buildAdoptedSession(candidate: ExternalSessionCandidate): Session {
  return new Session({
    workingDir: candidate.workingDir,
    mode: candidate.mode as SessionMode,
    name: `tmux:${candidate.tmuxSession}`,
    externalHost: { socket: candidate.socket, tmuxSession: candidate.tmuxSession },
    useMux: false,
  });
}

/**
 * Adopt a discovered external tmux session: build a detach-only `Session`, wire
 * it into `ctx.sessions`, broadcast `SessionCreated`, and attach the PTY. Returns
 * the registered session. Throws NOT_FOUND if the candidate has vanished and
 * OPERATION_FAILED if the session cap is reached; on attach failure the partially
 * registered session is removed before rethrowing.
 */
export async function adoptSessionCore(
  ctx: SessionCoreCtx,
  candidate: ExternalSessionCandidate,
  deps: AdoptSessionDeps = {}
): Promise<Session> {
  if (ctx.sessions.size >= MAX_CONCURRENT_SESSIONS) {
    throwApiError(
      ApiErrorCode.OPERATION_FAILED,
      `Maximum concurrent sessions (${MAX_CONCURRENT_SESSIONS}) reached. Delete some sessions first.`
    );
  }

  if (deps.listCandidates) {
    const stillExists = deps
      .listCandidates()
      .some((c) => c.socket === candidate.socket && c.tmuxSession === candidate.tmuxSession);
    if (!stillExists) {
      throwApiError(ApiErrorCode.NOT_FOUND, 'External tmux session is no longer available');
    }
  }

  const session = (deps.buildSession ?? buildAdoptedSession)(candidate);

  ctx.addSession(session);
  await ctx.setupSessionListeners(session);
  getLifecycleLog().log({ event: 'created', sessionId: session.id, name: session.name, mode: session.mode });

  // Light state — buffers are fetched on demand via /terminal (mirrors createSessionCore).
  ctx.broadcast(SseEvent.SessionCreated, ctx.getSessionStateWithRespawn(session));

  try {
    await session.startInteractive();
  } catch (err) {
    // Attach failed (foreign server/session gone) — undo the registration so a
    // dead tab doesn't linger, then surface the failure. cleanupSession with
    // killMux=false is detach-only (and adopted sessions are always detach-only
    // anyway), so this never touches the foreign session.
    await ctx.cleanupSession(session.id, false, 'adopt_failed');
    throwApiError(ApiErrorCode.OPERATION_FAILED, `Failed to adopt external tmux session: ${String(err)}`);
  }

  return session;
}
