/**
 * @fileoverview Session management routes.
 * Covers session CRUD, input/output, terminal buffer, quick-start, quick-run,
 * auto-clear, auto-compact, image watcher, flicker filter, and logout.
 */

import { FastifyInstance } from 'fastify';
import { join, dirname, extname } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import {
  ApiErrorCode,
  createErrorResponse,
  getErrorMessage,
  type ApiResponse,
  type SessionColor,
} from '../../types.js';
import { Session } from '../../session.js';
import { SseEvent } from '../sse-events.js';
import {
  CreateSessionSchema,
  SessionNameSchema,
  SessionColorSchema,
  RunPromptSchema,
  SessionInputWithLimitSchema,
  ResizeSchema,
  AutoClearSchema,
  AutoCompactSchema,
  AutoResumeSchema,
  ImageWatcherSchema,
  FlickerFilterSchema,
  QuickRunSchema,
  QuickStartSchema,
} from '../schemas.js';
import {
  autoConfigureRalph,
  CASES_DIR,
  computeSessionTerminalBuffer,
  createSessionCore,
  deleteSessionCore,
  findSessionOrFail,
  parseBody,
  persistAndBroadcastSession,
  SETTINGS_PATH,
  validatePathWithinBase,
} from '../route-helpers.js';
import { AUTH_COOKIE_NAME } from '../middleware/auth.js';
import {
  writeHooksConfig,
  updateCaseModel,
  stripCaseEnvKeys,
  applyStatusLineConfig,
  refreshStaleHookSecret,
} from '../../hooks-config.js';
import { generateClaudeMd } from '../../templates/claude-md.js';
import { listHistorySessions } from '../history-sessions-core.js';
import { imageWatcher } from '../../image-watcher.js';
import { getLifecycleLog } from '../../session-lifecycle-log.js';
import type { SessionPort, EventPort, ConfigPort, InfraPort, AuthPort } from '../ports/index.js';
import { MAX_CONCURRENT_SESSIONS } from '../../config/map-limits.js';
import { RunSummaryTracker } from '../../run-summary.js';

import { MAX_INPUT_LENGTH, MAX_SESSION_NAME_LENGTH } from '../../config/terminal-limits.js';
import { MAX_PASTE_IMAGE_BYTES } from '../../config/buffer-limits.js';
import { dataPath } from '../../config/instance.js';

// Path to linked-cases registry (same file used by case-routes resolveCasePath)
const LINKED_CASES_FILE = dataPath('linked-cases.json');

// Moved to route-helpers.ts (needed there by readSessionTerminalBuffer /
// computeSessionTerminalBuffer, shared with fleet). Re-exported here so
// existing imports (test/strip-ink-redraw-bloat.test.ts) keep working.
export { stripInkRedrawBloat } from '../route-helpers.js';

/**
 * Validate image bytes against a declared extension. Sniffs the first ~12 bytes
 * for a known magic-number signature. Defends against polyglots (e.g. HTML or
 * SVG disguised under a `Content-Type: image/png` header) and against simple
 * extension-only spoofing — both the multipart filename and the Content-Type
 * are attacker-controlled, the raw bytes are not.
 *
 * Signatures: https://en.wikipedia.org/wiki/List_of_file_signatures
 */
export function imageMagicMatchesExt(data: Buffer, ext: string): boolean {
  if (data.length < 12) return false;
  const u32be = (off: number): number => data.readUInt32BE(off);
  switch (ext) {
    case '.png':
      return u32be(0) === 0x89504e47 && u32be(4) === 0x0d0a1a0a;
    case '.jpg':
    case '.jpeg':
      return data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    case '.gif':
      return (
        data[0] === 0x47 &&
        data[1] === 0x49 &&
        data[2] === 0x46 &&
        data[3] === 0x38 &&
        (data[4] === 0x37 || data[4] === 0x39) &&
        data[5] === 0x61
      );
    case '.webp':
      // RIFF....WEBP
      return u32be(0) === 0x52494646 && u32be(8) === 0x57454250;
    case '.bmp':
      return data[0] === 0x42 && data[1] === 0x4d;
    default:
      return false;
  }
}

// Per-(IP, sessionId) token bucket for paste-image. 30 requests/minute.
// Bucket map entries are pruned when they drift > 1h stale to bound memory
// against a flood of unique IP keys.
const PASTE_RATE_TOKENS = 30;
const PASTE_RATE_REFILL_PER_MS = PASTE_RATE_TOKENS / 60_000;
const PASTE_BUCKET_TTL_MS = 60 * 60 * 1000;
const PASTE_BUCKET_GC_THRESHOLD = 1000;
const pasteRateBuckets = new Map<string, { tokens: number; lastRefill: number }>();

export function consumePasteToken(key: string, now: number = Date.now()): boolean {
  if (pasteRateBuckets.size > PASTE_BUCKET_GC_THRESHOLD) {
    for (const [k, b] of pasteRateBuckets) {
      if (now - b.lastRefill > PASTE_BUCKET_TTL_MS) pasteRateBuckets.delete(k);
    }
  }
  let b = pasteRateBuckets.get(key);
  if (!b) {
    b = { tokens: PASTE_RATE_TOKENS, lastRefill: now };
    pasteRateBuckets.set(key, b);
  }
  const delta = (now - b.lastRefill) * PASTE_RATE_REFILL_PER_MS;
  b.tokens = Math.min(PASTE_RATE_TOKENS, b.tokens + delta);
  b.lastRefill = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

// Test hook: reset between runs.
export function _resetPasteRateBuckets(): void {
  pasteRateBuckets.clear();
}

export function registerSessionRoutes(
  app: FastifyInstance,
  ctx: SessionPort & EventPort & ConfigPort & InfraPort & AuthPort
): void {
  // ═══════════════════════════════════════════════════════════════
  // Auth
  // ═══════════════════════════════════════════════════════════════

  // ========== Logout ==========

  app.post('/api/logout', async (req, reply) => {
    // Invalidate server-side session token (not just the browser cookie)
    const sessionToken = req.cookies[AUTH_COOKIE_NAME];
    if (sessionToken) {
      ctx.authSessions?.delete(sessionToken);
    }
    reply.clearCookie(AUTH_COOKIE_NAME, { path: '/' });
    return {};
  });

  // ═══════════════════════════════════════════════════════════════
  // Session CRUD (list, create, rename, color, delete, detail)
  // ═══════════════════════════════════════════════════════════════

  // ========== Session Listing ==========

  app.get('/api/sessions', async () => {
    return ctx.getLightSessionsState();
  });

  // ========== Session Creation ==========

  app.post('/api/sessions', async (req) => {
    // Prevent unbounded session creation. Checked here (before the disk
    // side-effects below) so a request that's going to be rejected never
    // performs them; createSessionCore re-checks this for callers (fleet)
    // that don't have a handler validating first.
    if (ctx.sessions.size >= MAX_CONCURRENT_SESSIONS) {
      return createErrorResponse(
        ApiErrorCode.OPERATION_FAILED,
        `Maximum concurrent sessions (${MAX_CONCURRENT_SESSIONS}) reached. Delete some sessions first.`
      );
    }

    const body = parseBody(CreateSessionSchema, req.body);
    const workingDir = body.workingDir || process.cwd();

    // Validate workingDir exists and is a directory. Same reasoning as the
    // cap check above: validated here first so the disk side-effects below
    // don't run against a bogus path; createSessionCore re-validates too.
    if (body.workingDir) {
      try {
        const stat = statSync(workingDir);
        if (!stat.isDirectory()) {
          return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'workingDir is not a directory');
        }
      } catch {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'workingDir does not exist');
      }
    }

    // envOverrides flow through Session → tmux setenv (ephemeral, per-session).
    //
    // For keys the caller is actively setting, strip any stale disk entry a prior
    // Codeman version may have written. Scope limited to:
    //   - Claude mode (OpenCode/Codex/Gemini don't read .claude/settings.local.json)
    //   - workingDir inside CASES_DIR (Codeman's managed territory — we never mutate
    //     .claude/settings.local.json in arbitrary user repos that POST /api/sessions
    //     can target, because those may have hand-authored values).
    const canStripDisk =
      body.mode !== 'opencode' &&
      body.mode !== 'codex' &&
      body.mode !== 'gemini' &&
      body.envOverrides &&
      Object.keys(body.envOverrides).length > 0 &&
      workingDir.startsWith(CASES_DIR + '/');
    if (canStripDisk) {
      await stripCaseEnvKeys(workingDir, Object.keys(body.envOverrides!));
    }

    // Write model override to .claude/settings.local.json if provided
    if (body.modelOverride !== undefined) {
      await updateCaseModel(workingDir, body.modelOverride || null);
    }

    // Plan-usage statusLine exporter (App Settings → Display → "Plan Usage
    // Limits"). Claude-only; runs for ANY working dir (linked cases / real repos,
    // where most sessions live), mirroring updateCaseModel above.
    //
    // ADD-ONLY: we never remove on create. Sessions in a repo share one
    // settings.local.json, so a single create-with-false (e.g. a client whose
    // synced setting hadn't loaded yet) must NOT yank the statusLine out from
    // under other live sessions in that repo — that breaks their footer + the
    // chip's data feed for everyone. The exporter is benign when the chip is off
    // (the footer just shows session status). isOurs-guarded so a user's own
    // statusLine is never touched.
    if ((body.mode ?? 'claude') === 'claude' && body.statusLineTelemetry === true) {
      await applyStatusLineConfig(workingDir, true);
    }

    // COD-91 self-heal: refresh a pre-secret hooks block in an existing case so the now
    // unconditional hook-secret gate keeps accepting its hook events. No-op for fresh
    // cases (writeHooksConfig already wrote the secret) and for non-Codeman/absent hooks.
    if ((body.mode ?? 'claude') === 'claude') {
      await refreshStaleHookSecret(workingDir).catch(() => {});
    }

    // Pre-validate resumeSessionId: check that the conversation file actually exists
    // in Claude's projects directory. If not, skip resume to avoid confusing
    // "No conversation found" errors from Claude CLI.
    let validatedResumeId = body.resumeSessionId;
    if (validatedResumeId) {
      const projectsDir = join(process.env.HOME || '/tmp', '.claude', 'projects');
      let found = false;
      try {
        const projectDirs = await fs.readdir(projectsDir);
        for (const projDir of projectDirs) {
          const sessionFile = join(projectsDir, projDir, `${validatedResumeId}.jsonl`);
          try {
            const stat = await fs.stat(sessionFile);
            if (stat.size > 4000) {
              found = true;
              break;
            }
          } catch {
            // File doesn't exist in this project dir
          }
        }
      } catch {
        // Projects dir doesn't exist
      }
      if (!found) {
        console.log(`[Session] Resume session ${validatedResumeId} not found on disk, starting fresh`);
        validatedResumeId = undefined;
      }
    }

    // Session mechanics (cap/workingDir re-check, mode-specific CLI-availability
    // check, Session construction, wiring, persistence, broadcast) live in
    // createSessionCore — shared with fleet's device adapter. REST never passes
    // opts.start: sessions are started later via the separate /interactive or
    // /shell endpoints below, unchanged.
    const session = await createSessionCore(ctx, {
      workingDir,
      mode: body.mode,
      name: body.name,
      openCodeConfig: body.openCodeConfig,
      codexConfig: body.codexConfig,
      geminiConfig: body.geminiConfig,
      resumeSessionId: validatedResumeId,
      envOverrides: body.envOverrides,
      effort: body.effort,
    });

    // Use light state for the response — buffers are fetched on-demand via /terminal.
    // Avoids serializing 2-3MB of terminal+text buffers per session creation.
    return { session: ctx.getSessionStateWithRespawn(session) };
  });

  // ========== Rename Session ==========

  app.put('/api/sessions/:id/name', async (req) => {
    const { id } = req.params as { id: string };
    const body = parseBody(SessionNameSchema, req.body, 'Invalid request body');
    const session = findSessionOrFail(ctx, id);

    const name = String(body.name || '').slice(0, MAX_SESSION_NAME_LENGTH);
    session.name = name;
    // Also update the mux session name if applicable
    ctx.mux.updateSessionName(id, session.name);
    persistAndBroadcastSession(ctx, session);
    return { name: session.name };
  });

  // ========== Set Session Color ==========

  app.put('/api/sessions/:id/color', async (req) => {
    const { id } = req.params as { id: string };
    const body = parseBody(SessionColorSchema, req.body, 'Invalid request body');
    const session = findSessionOrFail(ctx, id);

    const validColors = ['default', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'];
    if (!validColors.includes(body.color)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid color');
    }

    session.setColor(body.color as SessionColor);
    persistAndBroadcastSession(ctx, session);
    return { color: session.color };
  });

  // ========== Delete Session ==========

  app.delete('/api/sessions/:id', async (req) => {
    const { id } = req.params as { id: string };
    const query = req.query as { killMux?: string };
    const killMux = query.killMux !== 'false'; // Default to true

    await deleteSessionCore(ctx, id, killMux);
    return {};
  });

  // ========== Delete All Sessions ==========

  app.delete('/api/sessions', async (): Promise<ApiResponse<{ killed: number }>> => {
    const sessionIds = Array.from(ctx.sessions.keys());
    let killed = 0;

    for (const id of sessionIds) {
      if (ctx.sessions.has(id)) {
        await ctx.cleanupSession(id, true, 'user_bulk_delete');
        killed++;
      }
    }

    return { success: true, data: { killed } };
  });

  // ========== Get Session Detail ==========

  app.get('/api/sessions/:id', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id);

    // Use light state (no full buffers) — terminal buffer available via /terminal endpoint.
    // Full buffers were 2-3MB and caused slowness when polled frequently (e.g. Ralph wizard).
    return ctx.getSessionStateWithRespawn(session);
  });

  // ═══════════════════════════════════════════════════════════════
  // Session Data (output, ralph state, run summary, active tools)
  // ═══════════════════════════════════════════════════════════════

  // ========== Get Session Output ==========

  app.get('/api/sessions/:id/output', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id);

    return {
      success: true,
      data: {
        textOutput: session.textOutput,
        messages: session.messages,
        errorBuffer: session.errorBuffer,
      },
    };
  });

  // ========== Get Ralph State ==========

  app.get('/api/sessions/:id/ralph-state', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id);

    return {
      success: true,
      data: {
        loop: session.ralphLoopState,
        todos: session.ralphTodos,
        todoStats: session.ralphTodoStats,
      },
    };
  });

  // ========== Get Run Summary ==========

  app.get('/api/sessions/:id/run-summary', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id);

    const tracker = ctx.runSummaryTrackers.get(id);
    if (!tracker) {
      // Create a fresh tracker if one doesn't exist (shouldn't happen normally)
      const newTracker = new RunSummaryTracker(id, session.name);
      ctx.runSummaryTrackers.set(id, newTracker);
      return { summary: newTracker.getSummary() };
    }

    // Update session name in case it changed
    tracker.setSessionName(session.name);

    return { summary: tracker.getSummary() };
  });

  // ========== Get Active Tools ==========

  app.get('/api/sessions/:id/active-tools', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id);

    return {
      success: true,
      data: {
        tools: session.activeTools,
      },
    };
  });

  // ═══════════════════════════════════════════════════════════════
  // Session Execution (run prompt, interactive mode, shell mode)
  // ═══════════════════════════════════════════════════════════════

  // ========== Run Prompt ==========

  app.post('/api/sessions/:id/run', async (req) => {
    const { id } = req.params as { id: string };
    const { prompt } = parseBody(RunPromptSchema, req.body);
    const session = findSessionOrFail(ctx, id);

    if (session.isBusy()) {
      return createErrorResponse(ApiErrorCode.SESSION_BUSY, 'Session is busy');
    }

    // Run async, don't wait
    session.runPrompt(prompt).catch((err) => {
      ctx.broadcast(SseEvent.SessionError, { id, error: err.message });
    });

    ctx.broadcast(SseEvent.SessionRunning, { id, prompt });
    return {};
  });

  // ========== Start Interactive Mode ==========

  app.post('/api/sessions/:id/interactive', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id);

    if (session.isBusy()) {
      return createErrorResponse(ApiErrorCode.SESSION_BUSY, 'Session is busy');
    }

    try {
      // Auto-detect completion phrase from CLAUDE.md BEFORE starting (only if globally enabled and not explicitly disabled by user)
      // Ralph tracker is not supported for opencode / codex / gemini sessions
      if (
        session.mode !== 'opencode' &&
        session.mode !== 'codex' &&
        session.mode !== 'gemini' &&
        ctx.store.getConfig().ralphEnabled &&
        !session.ralphTracker.autoEnableDisabled
      ) {
        autoConfigureRalph(session, session.workingDir, ctx);
        if (!session.ralphTracker.enabled) {
          session.ralphTracker.enable();
        }
      }

      await session.startInteractive();
      getLifecycleLog().log({
        event: 'started',
        sessionId: id,
        name: session.name,
        mode: session.mode,
      });
      ctx.broadcast(SseEvent.SessionInteractive, { id });
      ctx.broadcast(SseEvent.SessionUpdated, { session: ctx.getSessionStateWithRespawn(session) });

      return {};
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });

  // ========== Start Shell Mode ==========

  app.post('/api/sessions/:id/shell', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id);

    if (session.isBusy()) {
      return createErrorResponse(ApiErrorCode.SESSION_BUSY, 'Session is busy');
    }

    try {
      await session.startShell();
      getLifecycleLog().log({
        event: 'started',
        sessionId: id,
        name: session.name,
        mode: 'shell',
      });
      ctx.broadcast(SseEvent.SessionInteractive, { id, mode: 'shell' });
      ctx.broadcast(SseEvent.SessionUpdated, { session: ctx.getSessionStateWithRespawn(session) });
      return {};
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // Terminal I/O (input, resize, buffer)
  // ═══════════════════════════════════════════════════════════════

  // ========== Send Input ==========

  app.post('/api/sessions/:id/input', async (req) => {
    const { id } = req.params as { id: string };
    const { input, useMux, seq, clientId } = parseBody(SessionInputWithLimitSchema, req.body);
    const session = findSessionOrFail(ctx, id);

    const inputStr = String(input);
    if (inputStr.length > MAX_INPUT_LENGTH) {
      return createErrorResponse(
        ApiErrorCode.INVALID_INPUT,
        `Input exceeds maximum length (${MAX_INPUT_LENGTH} bytes)`
      );
    }

    // Reliable delivery (POST fallback when the WebSocket is down): a 2xx IS the
    // client's ACK, so a tagged duplicate redelivery must still return 200 but
    // skip the write. Untagged requests (curl/legacy) always apply.
    if (typeof clientId === 'string' && typeof seq === 'number' && !session.shouldApplyInput(clientId, seq)) {
      return {};
    }

    // Write input to PTY. Direct write is synchronous; writeViaMux
    // (tmux send-keys) is fire-and-forget to avoid blocking the HTTP response.
    if (useMux) {
      // Fire-and-forget: don't block HTTP response on tmux child process.
      // Fallback to direct write on failure.
      session
        .writeViaMux(inputStr)
        .then((ok) => {
          if (!ok) {
            console.warn(`[Server] writeViaMux failed for session ${id}, falling back to direct write`);
            session.write(inputStr);
          }
        })
        .catch(() => {
          session.write(inputStr);
        });
    } else {
      session.write(inputStr);
    }
    return {};
  });

  // ========== Send Named Key (tmux send-keys -H) ==========
  // Sends raw hex bytes to tmux pane for keys like Shift+Enter / Ctrl+Enter.
  // Uses send-keys -H (hex) to inject 0x0a (line feed) which Claude Code's
  // Ink input recognizes as "insert newline" vs 0x0d (carriage return = submit).

  app.post('/api/sessions/:id/send-key', async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    const key = typeof body?.key === 'string' ? body.key : '';

    // Map key names to hex byte sequences
    const KEY_HEX_MAP: Record<string, string[]> = {
      'S-Enter': ['0a'], // \n (line feed)
      'C-Enter': ['0a'], // \n (line feed)
    };
    const hex = KEY_HEX_MAP[key];
    if (!hex) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, `Key not allowed: ${key}`);
    }

    const session = findSessionOrFail(ctx, id);
    const muxName = session.muxName;
    if (!muxName) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'No tmux session');
    }

    try {
      // Route through the dedicated Codeman socket — bare `tmux` would target the
      // user's default server and never find this session (same #80 regression class).
      await new Promise<void>((resolve, reject) => {
        execFile(
          'tmux',
          ['-L', ctx.mux.muxSocket, 'send-keys', '-H', '-t', muxName, ...hex],
          { timeout: 5000 },
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });
    } catch (err) {
      console.error('[Server] send-key failed:', err);
      return createErrorResponse(ApiErrorCode.INTERNAL_ERROR, 'tmux send-keys failed');
    }
    return {};
  });

  // ========== Resize Terminal ==========

  app.post('/api/sessions/:id/resize', async (req) => {
    const { id } = req.params as { id: string };
    const { cols, rows, viewportType, force } = parseBody(ResizeSchema, req.body);
    const session = findSessionOrFail(ctx, id);

    session.resize(cols, rows, { viewportType, force });
    return {};
  });

  // ========== Get Last Response (from transcript JSONL) ==========

  // Resolves the most recent Claude conversation id for a session's cwd by
  // tailing ~/.claude/history.jsonl. After `/clear`, Claude Code keeps writing
  // to a new <uuid>.jsonl; history.jsonl is the only source-of-truth update
  // that does not rely on project-local hooks (we intentionally don't install
  // hooks in arbitrary user repos, see the POST /api/sessions comment).
  //
  // Entries from OTHER Codeman sessions in the same cwd are filtered out by
  // their known claudeSessionIds so concurrent tabs don't shadow each other,
  // as long as each has had its id resolved at least once.
  async function resolveActiveClaudeSessionIdFromHistory(
    session: Session,
    projectsDir: string
  ): Promise<string | null> {
    const historyPath = join(homedir(), '.claude', 'history.jsonl');
    const otherClaudeIds = new Set<string>();
    for (const s of ctx.sessions.values()) {
      if (s.id !== session.id && s.workingDir === session.workingDir && s.claudeSessionId) {
        otherClaudeIds.add(s.claudeSessionId);
      }
    }

    let candidateSid: string | null = null;
    try {
      const content = await fs.readFile(historyPath, 'utf8');
      const lines = content.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line) continue;
        try {
          const entry = JSON.parse(line) as { project?: string; sessionId?: string };
          if (
            entry.project === session.workingDir &&
            typeof entry.sessionId === 'string' &&
            !otherClaudeIds.has(entry.sessionId)
          ) {
            candidateSid = entry.sessionId;
            break;
          }
        } catch {
          // Skip unparseable lines
        }
      }
    } catch {
      return null;
    }
    if (!candidateSid || candidateSid === session.id) return candidateSid;

    // Safety: only adopt if the candidate's jsonl is more recently written
    // than our initial conversation's jsonl. Blocks stale ids inherited from
    // a prior Codeman session that happened to share this cwd.
    try {
      const projectDirs = await fs.readdir(projectsDir);
      let candidateMtime = 0;
      let initialMtime = 0;
      for (const projDir of projectDirs) {
        try {
          const cs = await fs.stat(join(projectsDir, projDir, `${candidateSid}.jsonl`));
          if (cs.mtimeMs > candidateMtime) candidateMtime = cs.mtimeMs;
        } catch {
          /* not in this dir */
        }
        try {
          const is = await fs.stat(join(projectsDir, projDir, `${session.id}.jsonl`));
          if (is.mtimeMs > initialMtime) initialMtime = is.mtimeMs;
        } catch {
          /* not in this dir */
        }
      }
      if (candidateMtime === 0) return null;
      if (initialMtime > 0 && candidateMtime <= initialMtime) return null;
    } catch {
      return null;
    }
    return candidateSid;
  }

  app.get('/api/sessions/:id/last-response', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id);

    // Scan ~/.claude/projects/*/ for the transcript file
    const projectsDir = join(process.env.HOME || '/tmp', '.claude', 'projects');

    // Adopt the current conversation id if the user ran `/clear` — Claude CLI's
    // interactive PTY emits no JSON on stdout, so without this lookup the
    // stored id stays pinned to the pre-/clear transcript.
    const activeId = await resolveActiveClaudeSessionIdFromHistory(session, projectsDir);
    if (activeId && activeId !== session.claudeSessionId) {
      session.adoptClaudeSessionId(activeId);
    }

    // The Claude conversation ID (used as JSONL filename)
    const claudeSessionId = session.claudeSessionId || session.id;
    let transcriptText = '';
    let transcriptTimestamp = '';

    try {
      const projectDirs = await fs.readdir(projectsDir);
      for (const projDir of projectDirs) {
        const jsonlPath = join(projectsDir, projDir, `${claudeSessionId}.jsonl`);
        try {
          const content = await fs.readFile(jsonlPath, 'utf8');
          const lines = content.trim().split('\n');

          // Search from end for last assistant message with text
          for (let i = lines.length - 1; i >= 0; i--) {
            try {
              const entry = JSON.parse(lines[i]);
              if (entry.type === 'assistant' && entry.message?.content) {
                const blocks = Array.isArray(entry.message.content)
                  ? entry.message.content
                  : [{ type: 'text', text: String(entry.message.content) }];
                const textBlocks = blocks
                  .filter((b: { type: string; text?: string }) => b.type === 'text' && b.text)
                  .map((b: { type: string; text?: string }) => b.text);
                if (textBlocks.length > 0) {
                  transcriptText = textBlocks.join('\n\n');
                  transcriptTimestamp = entry.timestamp || '';
                  break;
                }
              }
            } catch {
              // Skip unparseable lines
            }
          }
          if (transcriptText) break; // Found it, stop scanning directories
        } catch {
          // File doesn't exist in this project dir, continue
        }
      }
    } catch {
      // projects dir doesn't exist
    }

    // If ?context=full, return all user+assistant messages for conversation view
    const query = req.query as { context?: string };
    if (query.context === 'full' && transcriptText) {
      const allMessages: Array<{ role: string; text: string; timestamp?: string }> = [];
      try {
        const projectDirs = await fs.readdir(projectsDir);
        for (const projDir of projectDirs) {
          const jsonlPath = join(projectsDir, projDir, `${claudeSessionId}.jsonl`);
          try {
            const content = await fs.readFile(jsonlPath, 'utf8');
            const lines = content.trim().split('\n');
            for (const line of lines) {
              try {
                const entry = JSON.parse(line);
                if (entry.type === 'user' && entry.message?.content) {
                  const text =
                    typeof entry.message.content === 'string'
                      ? entry.message.content
                      : (entry.message.content as Array<{ type: string; text?: string }>)
                          .filter((b) => b.type === 'text' && b.text)
                          .map((b) => b.text)
                          .join('\n');
                  // Skip system/command messages
                  if (text && !text.startsWith('<local-command') && !text.startsWith('<command-name>')) {
                    allMessages.push({ role: 'user', text, timestamp: entry.timestamp });
                  }
                } else if (entry.type === 'assistant' && entry.message?.content) {
                  const blocks = Array.isArray(entry.message.content)
                    ? entry.message.content
                    : [{ type: 'text', text: String(entry.message.content) }];
                  const text = blocks
                    .filter((b: { type: string; text?: string }) => b.type === 'text' && b.text)
                    .map((b: { type: string; text?: string }) => b.text)
                    .join('\n\n');
                  if (text) {
                    allMessages.push({ role: 'assistant', text, timestamp: entry.timestamp });
                  }
                }
              } catch {
                /* skip */
              }
            }
            if (allMessages.length > 0) break;
          } catch {
            /* continue */
          }
        }
      } catch {
        /* ignore */
      }
      return { text: transcriptText, timestamp: transcriptTimestamp, messages: allMessages };
    }

    return {
      text: transcriptText,
      timestamp: transcriptTimestamp,
    };
  });

  // ========== Get Terminal Buffer ==========

  // Query params:
  //   tail=<bytes> - Only return last N bytes (faster initial load)
  app.get('/api/sessions/:id/terminal', async (req) => {
    const { id } = req.params as { id: string };
    const query = req.query as { tail?: string };
    const session = findSessionOrFail(ctx, id);
    const tailBytes = query.tail ? parseInt(query.tail, 10) : 0;

    // Buffer reconstruction (live-pane prepend + Ink/alt-screen cleanup + tail)
    // lives in route-helpers.ts, shared with fleet's device adapter.
    const { terminalBuffer, fullSize, truncated } = computeSessionTerminalBuffer(ctx, session, tailBytes);

    return {
      terminalBuffer,
      status: session.status,
      fullSize,
      truncated,
    };
  });

  // ═══════════════════════════════════════════════════════════════
  // Session Settings (auto-clear, auto-compact, image watcher, flicker filter)
  // ═══════════════════════════════════════════════════════════════

  // ========== Auto-Clear ==========

  app.post('/api/sessions/:id/auto-clear', async (req) => {
    const { id } = req.params as { id: string };
    const body = parseBody(AutoClearSchema, req.body, 'Invalid request body');
    const session = findSessionOrFail(ctx, id);

    session.setAutoClear(body.enabled, body.threshold);
    persistAndBroadcastSession(ctx, session);

    return {
      success: true,
      data: {
        autoClear: {
          enabled: session.autoClearEnabled,
          threshold: session.autoClearThreshold,
        },
      },
    };
  });

  // ========== Auto-Compact ==========

  app.post('/api/sessions/:id/auto-compact', async (req) => {
    const { id } = req.params as { id: string };
    const body = parseBody(AutoCompactSchema, req.body, 'Invalid request body');
    const session = findSessionOrFail(ctx, id);

    session.setAutoCompact(body.enabled, body.threshold, body.prompt);
    persistAndBroadcastSession(ctx, session);

    return {
      success: true,
      data: {
        autoCompact: {
          enabled: session.autoCompactEnabled,
          threshold: session.autoCompactThreshold,
          prompt: session.autoCompactPrompt,
        },
      },
    };
  });

  // ========== Auto-Resume (usage-limit pause) ==========

  app.post('/api/sessions/:id/auto-resume', async (req) => {
    const { id } = req.params as { id: string };
    const body = parseBody(AutoResumeSchema, req.body, 'Invalid request body');
    const session = findSessionOrFail(ctx, id);

    session.setAutoResume(body.enabled);
    persistAndBroadcastSession(ctx, session);

    return {
      success: true,
      data: {
        autoResume: {
          enabled: session.autoResumeEnabled,
          resumeAt: session.autoResumeAt ?? undefined,
        },
      },
    };
  });

  // ========== Image Watcher ==========

  app.post('/api/sessions/:id/image-watcher', async (req) => {
    const { id } = req.params as { id: string };
    const body = parseBody(ImageWatcherSchema, req.body, 'Invalid request body');
    const session = findSessionOrFail(ctx, id);

    if (body.enabled) {
      imageWatcher.watchSession(session.id, session.workingDir);
    } else {
      imageWatcher.unwatchSession(session.id);
    }

    // Store state on session for persistence
    session.imageWatcherEnabled = body.enabled;
    ctx.persistSessionState(session);

    return {
      success: true,
      data: {
        imageWatcherEnabled: body.enabled,
      },
    };
  });

  // ========== Flicker Filter ==========

  app.post('/api/sessions/:id/flicker-filter', async (req) => {
    const { id } = req.params as { id: string };
    const body = parseBody(FlickerFilterSchema, req.body, 'Invalid request body');
    const session = findSessionOrFail(ctx, id);

    session.flickerFilterEnabled = body.enabled;
    persistAndBroadcastSession(ctx, session);

    return {
      success: true,
      data: {
        flickerFilterEnabled: body.enabled,
      },
    };
  });

  // ═══════════════════════════════════════════════════════════════
  // Quick Actions (quick-run, quick-start)
  // ═══════════════════════════════════════════════════════════════

  // ========== Quick Run ==========

  app.post('/api/run', async (req) => {
    // Prevent unbounded session creation
    if (ctx.sessions.size >= MAX_CONCURRENT_SESSIONS) {
      return createErrorResponse(
        ApiErrorCode.SESSION_BUSY,
        `Maximum concurrent sessions (${MAX_CONCURRENT_SESSIONS}) reached`
      );
    }

    const {
      prompt,
      workingDir,
      envOverrides: runEnvOverrides,
    } = parseBody(QuickRunSchema, req.body, 'Invalid request body');

    if (!prompt.trim()) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'prompt is required');
    }
    const dir = workingDir || process.cwd();

    // Validate workingDir exists and is a directory
    if (workingDir) {
      try {
        const stat = statSync(dir);
        if (!stat.isDirectory()) {
          return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'workingDir is not a directory');
        }
      } catch {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'workingDir does not exist');
      }
    }

    const session = new Session({ workingDir: dir, envOverrides: runEnvOverrides });
    ctx.addSession(session);
    ctx.store.incrementSessionsCreated();
    ctx.persistSessionState(session);
    await ctx.setupSessionListeners(session);
    getLifecycleLog().log({
      event: 'created',
      sessionId: session.id,
      name: session.name,
      reason: 'run_prompt',
    });

    ctx.broadcast(SseEvent.SessionCreated, ctx.getSessionStateWithRespawn(session));

    try {
      const result = await session.runPrompt(prompt);
      // Clean up session after completion to prevent memory leak
      await ctx.cleanupSession(session.id, true, 'run_prompt_complete');
      return { sessionId: session.id, ...result };
    } catch (err) {
      // Clean up session on error too. The session is destroyed here, so its id
      // is only useful for log correlation — carry it in the error message.
      await ctx.cleanupSession(session.id, true, 'run_prompt_error');
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `${getErrorMessage(err)} (session ${session.id})`);
    }
  });

  // ========== Quick Start ==========

  app.post('/api/quick-start', async (req) => {
    // Prevent unbounded session creation
    if (ctx.sessions.size >= MAX_CONCURRENT_SESSIONS) {
      return createErrorResponse(
        ApiErrorCode.SESSION_BUSY,
        `Maximum concurrent sessions (${MAX_CONCURRENT_SESSIONS}) reached.`
      );
    }

    const {
      caseName = 'testcase',
      mode = 'claude',
      openCodeConfig,
      codexConfig,
      geminiConfig,
      envOverrides,
      effort,
    } = parseBody(QuickStartSchema, req.body);

    // Check OpenCode availability if requested
    if (mode === 'opencode') {
      const { isOpenCodeAvailable } = await import('../../utils/opencode-cli-resolver.js');
      if (!isOpenCodeAvailable()) {
        return createErrorResponse(
          ApiErrorCode.OPERATION_FAILED,
          'OpenCode CLI not found. Install with: curl -fsSL https://opencode.ai/install | bash'
        );
      }
    }

    // Check Codex availability if requested
    if (mode === 'codex') {
      const { isCodexAvailable } = await import('../../utils/codex-cli-resolver.js');
      if (!isCodexAvailable()) {
        return createErrorResponse(
          ApiErrorCode.OPERATION_FAILED,
          'Codex CLI not found. Install with: npm install -g @openai/codex'
        );
      }
    }

    // Check Gemini availability if requested
    if (mode === 'gemini') {
      const { isGeminiAvailable } = await import('../../utils/gemini-cli-resolver.js');
      if (!isGeminiAvailable()) {
        return createErrorResponse(
          ApiErrorCode.OPERATION_FAILED,
          'Gemini CLI not found. Install with: npm install -g @google/gemini-cli'
        );
      }
    }

    // Resolve case path: check linked-cases registry first, then fall back to CASES_DIR.
    // This mirrors the behaviour of resolveCasePath() in case-routes so that linked
    // external project directories are honoured by quick-start just like regular case routes.
    let linkedCases: Record<string, string> = {};
    try {
      const raw = await fs.readFile(LINKED_CASES_FILE, 'utf-8');
      linkedCases = JSON.parse(raw);
    } catch {
      // File missing or unparseable — treat as empty registry
    }
    const linkedCasePath = linkedCases[caseName];
    const casePath = linkedCasePath || validatePathWithinBase(caseName, CASES_DIR);
    if (!casePath) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid case path');
    }

    // Create case folder and CLAUDE.md if it doesn't exist (only for non-linked cases)
    if (!existsSync(casePath)) {
      try {
        mkdirSync(casePath, { recursive: true });
        mkdirSync(join(casePath, 'src'), { recursive: true });

        // Read settings to get custom template path
        const templatePath = await ctx.getDefaultClaudeMdPath();
        const claudeMd = generateClaudeMd(caseName, '', templatePath);
        writeFileSync(join(casePath, 'CLAUDE.md'), claudeMd);

        // Write .claude/settings.local.json with hooks for desktop notifications
        // (Claude-specific — OpenCode, Codex, and Gemini use their own systems)
        if (mode !== 'opencode' && mode !== 'codex' && mode !== 'gemini') {
          await writeHooksConfig(casePath);
        }

        ctx.broadcast(SseEvent.CaseCreated, { name: caseName, path: casePath });
      } catch (err) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to create case: ${getErrorMessage(err)}`);
      }
    } else if (mode !== 'opencode') {
      // COD-91 self-heal for an EXISTING case: refresh a pre-secret hooks block so the
      // now-unconditional hook-secret gate keeps accepting its hook events. No-op when
      // the hooks aren't ours or already carry the secret.
      await refreshStaleHookSecret(casePath).catch(() => {});
    }

    // Strip stale disk entries for keys this request is actively setting (Claude only —
    // see POST /api/sessions for full rationale).
    if (
      mode !== 'opencode' &&
      mode !== 'codex' &&
      mode !== 'gemini' &&
      envOverrides &&
      Object.keys(envOverrides).length > 0
    ) {
      await stripCaseEnvKeys(casePath, Object.keys(envOverrides));
    }

    // Create a new session with the case as working directory
    // Apply global Nice priority config and model config from settings
    const niceConfig = await ctx.getGlobalNiceConfig();
    const qsModelConfig = await ctx.getModelConfig();
    const qsModel =
      mode === 'opencode'
        ? openCodeConfig?.model
        : mode === 'codex'
          ? codexConfig?.model
          : mode === 'gemini'
            ? geminiConfig?.model
            : mode !== 'shell'
              ? qsModelConfig?.defaultModel || undefined
              : undefined;
    const qsClaudeModeConfig = await ctx.getClaudeModeConfig();
    const qsTerminalHistoryConfig = await ctx.getTerminalHistoryConfig();
    const session = new Session({
      workingDir: casePath,
      mux: ctx.mux,
      useMux: true,
      mode: mode,
      niceConfig: niceConfig,
      model: qsModel,
      claudeMode: qsClaudeModeConfig.claudeMode,
      allowedTools: qsClaudeModeConfig.allowedTools,
      openCodeConfig: mode === 'opencode' ? openCodeConfig : undefined,
      codexConfig: mode === 'codex' ? codexConfig : undefined,
      geminiConfig: mode === 'gemini' ? geminiConfig : undefined,
      envOverrides,
      effort,
      tmuxHistoryLimit: qsTerminalHistoryConfig.tmuxHistoryLimit,
    });

    // Auto-detect completion phrase from CLAUDE.md BEFORE broadcasting
    // so the initial state already has the phrase configured (only if globally enabled)
    if (mode === 'claude' && ctx.store.getConfig().ralphEnabled) {
      autoConfigureRalph(session, casePath, ctx);
      if (!session.ralphTracker.enabled) {
        session.ralphTracker.enable();
        session.ralphTracker.enableAutoEnable(); // Allow re-enabling on restart
      }
    }

    ctx.addSession(session);
    ctx.store.incrementSessionsCreated();
    ctx.persistSessionState(session);
    await ctx.setupSessionListeners(session);
    getLifecycleLog().log({
      event: 'created',
      sessionId: session.id,
      name: session.name,
      reason: 'quick_start',
    });
    ctx.broadcast(SseEvent.SessionCreated, ctx.getSessionStateWithRespawn(session));

    // Start in the appropriate mode
    try {
      if (mode === 'shell') {
        await session.startShell();
        getLifecycleLog().log({
          event: 'started',
          sessionId: session.id,
          name: session.name,
          mode: 'shell',
        });
        ctx.broadcast(SseEvent.SessionInteractive, { id: session.id, mode: 'shell' });
      } else {
        // 'claude', 'opencode', 'codex', and 'gemini' modes use startInteractive()
        await session.startInteractive();
        getLifecycleLog().log({
          event: 'started',
          sessionId: session.id,
          name: session.name,
          mode,
        });
        ctx.broadcast(SseEvent.SessionInteractive, { id: session.id, mode });
      }
      ctx.broadcast(SseEvent.SessionUpdated, { session: ctx.getSessionStateWithRespawn(session) });

      // Save lastUsedCase to settings for TUI/web sync
      try {
        const settingsFilePath = SETTINGS_PATH;
        let settings: Record<string, unknown> = {};
        try {
          settings = JSON.parse(await fs.readFile(settingsFilePath, 'utf-8'));
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
        settings.lastUsedCase = caseName;
        const dir = dirname(settingsFilePath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        // Use async write to avoid blocking event loop
        fs.writeFile(settingsFilePath, JSON.stringify(settings, null, 2)).catch((err) => {
          // Non-critical but log for debugging
          console.warn('[Server] Failed to save settings (lastUsedCase):', err);
        });
      } catch (err) {
        // Non-critical but log for debugging
        console.warn('[Server] Failed to prepare settings update:', err);
      }

      return {
        sessionId: session.id,
        casePath,
        caseName,
      };
    } catch (err) {
      // Clean up session on error to prevent orphaned resources
      await ctx.cleanupSession(session.id, true, 'quick_start_error');
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // History — list past Claude conversations for resume
  // ═══════════════════════════════════════════════════════════════

  app.get('/api/history/sessions', async (req) => {
    const query = req.query as { projectKey?: string; offset?: string; limit?: string };
    // Handler = parse query → shared core (history-sessions-core.ts, reused by the fleet
    // resume-candidates path via LocalSessionOps) → serialize. Behavior is unchanged from
    // the pre-extraction inline scan: overview (no projectKey) caps at 50; drill-down pages.
    return listHistorySessions({
      projectKey: query.projectKey,
      offset: query.offset != null ? parseInt(query.offset, 10) : undefined,
      limit: query.limit != null ? parseInt(query.limit, 10) : undefined,
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Paste Image (clipboard / drag-drop upload)
  // ═══════════════════════════════════════════════════════════════

  const ALLOWED_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
  // The per-file size cap (MAX_PASTE_IMAGE_BYTES) is enforced by @fastify/multipart (registered in server.ts).

  app.post('/api/sessions/:id/paste-image', async (req, reply) => {
    // CSRF defense: state-changing routes must come from same origin.
    // Cookies are SameSite=lax, multipart/form-data is a "simple" CORS request
    // (no preflight), so a cross-origin <form enctype="multipart/form-data">
    // submit attaches the session cookie unimpeded. Reject unless Origin/Referer
    // matches req.host. Non-browser clients (no Origin AND no Referer) must
    // supply X-Codeman-CSRF — a header browsers cannot add cross-origin without
    // a preflight, which our CORS config does not allow from other origins.
    const reqHost = req.headers.host;
    const origin = req.headers.origin;
    const referer = req.headers.referer;
    let csrfOk = false;
    if (origin) {
      try {
        csrfOk = new URL(origin).host === reqHost;
      } catch {
        /* invalid Origin → not ok */
      }
    } else if (referer) {
      try {
        csrfOk = new URL(referer).host === reqHost;
      } catch {
        /* invalid Referer → not ok */
      }
    } else {
      csrfOk = !!req.headers['x-codeman-csrf'];
    }
    if (!csrfOk) {
      reply.code(403);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'CSRF check failed');
    }

    const { id } = req.params as { id: string };

    // Rate limit per (IP, sessionId): 30/min. Defends against disk-fill DoS
    // — even an authenticated attacker can otherwise loop large image POSTs.
    if (!consumePasteToken(`${req.ip}:${id}`)) {
      reply.code(429);
      reply.header('Retry-After', '60');
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Rate limit exceeded (30 uploads/min per session)');
    }

    const session = findSessionOrFail(ctx, id);

    if (!req.isMultipart()) {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Expected multipart/form-data');
    }

    // Read the single file part. @fastify/multipart enforces the per-file size
    // cap (MAX_PASTE_IMAGE_BYTES) and the 1-file/4-field count limits (server.ts),
    // replacing a hand-rolled
    // boundary scanner with several bugs: literal boundary matches anywhere in
    // body, LF-only clients silently corrupted the last byte (hard-coded \r\n
    // offsets), no part-count cap.
    let part: import('@fastify/multipart').MultipartFile | undefined;
    try {
      part = await req.file();
    } catch (err: unknown) {
      reply.code(413);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, getErrorMessage(err) || 'Invalid multipart payload');
    }
    if (!part) {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'No image uploaded');
    }
    if (part.fieldname !== 'image') {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, `Unexpected field "${part.fieldname}", expected "image"`);
    }
    let imageBytes: Buffer;
    try {
      imageBytes = await part.toBuffer();
    } catch (err: unknown) {
      reply.code(413);
      const maxMb = Math.round(MAX_PASTE_IMAGE_BYTES / (1024 * 1024));
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, getErrorMessage(err) || `File too large (max ${maxMb}MB)`);
    }
    if (imageBytes.length === 0) {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Empty file');
    }

    // Determine extension from filename or Content-Type.
    let ext = '.png';
    if (part.filename) {
      const origExt = extname(part.filename).toLowerCase();
      if (ALLOWED_IMAGE_EXTS.has(origExt)) ext = origExt;
    }
    const mimeMatch = (part.mimetype || '').toLowerCase().match(/^image\/(png|jpeg|jpg|webp|gif|bmp)$/);
    if (mimeMatch) {
      const map: Record<string, string> = {
        png: '.png',
        jpeg: '.jpg',
        jpg: '.jpg',
        webp: '.webp',
        gif: '.gif',
        bmp: '.bmp',
      };
      ext = map[mimeMatch[1]] ?? ext;
    }

    if (!ALLOWED_IMAGE_EXTS.has(ext)) {
      reply.code(400);
      return createErrorResponse(
        ApiErrorCode.INVALID_INPUT,
        `Unsupported image type: ${ext}. Allowed: ${[...ALLOWED_IMAGE_EXTS].join(', ')}`
      );
    }

    // Sniff actual bytes — filename and Content-Type are both attacker-supplied.
    // Polyglot HTML/PNG would otherwise pass and serve back with image/png MIME.
    if (!imageMagicMatchesExt(imageBytes, ext)) {
      // Diagnostic: on some Android galleries (e.g. MIUI) a WebP/HEIF is
      // mislabeled as image/jpeg, so the declared ext passes the allowlist but
      // the magic bytes do not. Log the real header so format mismatches can be
      // pinned down without a reproduce-and-guess loop. The client now
      // re-encodes images to JPEG/PNG before upload, so this should be rare.
      console.warn(
        `[paste-image] magic mismatch: filename=${JSON.stringify(part.filename)} mime=${JSON.stringify(part.mimetype)} declaredExt=${ext} magic=${imageBytes.subarray(0, 12).toString('hex')}`
      );
      reply.code(415);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, `Image bytes do not match declared type ${ext}`);
    }

    // Save to {workingDir}/.claude-images/
    // Refuse symlinks at imageDir — an agent or postinstall script could plant
    // `.claude-images -> ~/.ssh/` and redirect future writes outside workingDir.
    // We lstat (not stat) so we see the symlink itself. Use mkdir without
    // `recursive` so the leaf creation does not follow a symlink either, and
    // O_EXCL|O_NOFOLLOW on the file open so the write itself is symlink-safe.
    const imageDir = join(session.workingDir, '.claude-images');
    try {
      const dirStat = await fs.lstat(imageDir);
      if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
        reply.code(403);
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, '.claude-images is not a regular directory');
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // Non-recursive mkdir: does not follow symlinks for the leaf.
      // session.workingDir is guaranteed to exist (live session).
      try {
        await fs.mkdir(imageDir);
      } catch (mkErr: unknown) {
        // Concurrent uploads (a batch of photos) race to create .claude-images —
        // the losers get EEXIST. Treat an already-present REAL directory as
        // success, but re-verify it isn't a symlink a racing actor planted
        // (preserve the symlink-safety guarantee above).
        if ((mkErr as NodeJS.ErrnoException).code !== 'EEXIST') throw mkErr;
        const raceStat = await fs.lstat(imageDir);
        if (raceStat.isSymbolicLink() || !raceStat.isDirectory()) {
          reply.code(403);
          return createErrorResponse(ApiErrorCode.INVALID_INPUT, '.claude-images is not a regular directory');
        }
      }
    }
    // Date.now() collides on same-ms uploads from two tabs (last-write wins
    // silently). Append 8 hex chars so concurrent pastes get distinct names.
    const filename = `paste-${Date.now()}-${randomBytes(4).toString('hex')}${ext}`;
    const filepath = join(imageDir, filename);
    // O_EXCL: refuse to overwrite (collision is impossible with random suffix,
    // but defends against TOCTOU). O_NOFOLLOW: refuse if filepath is a symlink.
    const fh = await fs.open(
      filepath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW
    );
    try {
      await fh.writeFile(imageBytes);
    } finally {
      await fh.close();
    }

    return { path: filepath, filename };
  });
}
