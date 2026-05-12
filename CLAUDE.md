# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick Reference

| Task | Command |
|------|---------|
| Dev server | `npm run dev` (or `npx tsx src/index.ts web`) |
| Type check | `tsc --noEmit` |
| Lint | `npm run lint` (fix: `npm run lint:fix`) |
| Format | `npm run format` (check: `npm run format:check`) |
| Single test | `npm test -- test/<file>.test.ts` (or `npx vitest run --config config/vitest.config.ts test/<file>.test.ts`) — ⚠ **never** run bare `npm test`, see Testing section |
| Build | `npm run build` (esbuild via `scripts/build.mjs`, NOT tsc — `tsc --noEmit` is type-check only) |
| Production | `npm run build && systemctl --user restart codeman-web` |

## CRITICAL: Session Safety

**You may be running inside a Codeman-managed tmux session.** Before killing ANY tmux or Claude process:

1. Check: `echo $CODEMAN_MUX` - if `1`, you're in a managed session
2. **NEVER** run `tmux kill-session`, `pkill tmux`, or `pkill claude` without confirming
3. Use the web UI or `./scripts/tmux-manager.sh` instead of direct kill commands

## CRITICAL: Always Test Before Deploying

**NEVER COM without verifying your changes actually work.** For every fix:

1. **Backend changes**: Hit the API endpoint with `curl` and verify the response
2. **Frontend changes**: Use Playwright to load the page and assert the UI renders correctly. Use `waitUntil: 'domcontentloaded'` (not `networkidle` — SSE keeps the connection open). Wait 3-4s for polling/async data to populate, then check element visibility, text content, and CSS values
3. **Only after verification passes**, proceed with COM

The production server caches static files for 1 year (`maxAge: '1y'` in `server.ts`). After deploying frontend changes, users may need a hard refresh (Ctrl+Shift+R) to see updates.

## COM Shorthand (Deployment)

Uses [Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`) via `@changesets/cli`.

When user says "COM":
1. **Determine bump type**: `COM` = patch (default), `COM minor` = minor, `COM major` = major
2. **Create a changeset file** (no interactive prompts). Write a `.md` file in `.changeset/` with a random filename:
   ```bash
   cat > .changeset/$(openssl rand -hex 4).md << 'CHANGESET'
   ---
   "aicodeman": patch
   ---

   Detailed description of ALL changes since last release (not just the most recent commit — review full git log since last version tag)
   CHANGESET
   ```
   Replace `patch` with `minor` or `major` as needed. Include `"xterm-zerolag-input": patch` on a separate line if that package changed too.
3. **Consume the changeset**: `npm run version-packages` (auto-bumps `package.json` files, updates `CHANGELOG.md`, runs `npm install --package-lock-only`, and verifies lockfile sync via `scripts/check-lockfile-sync.mjs` — all in one command; never hand-edit `CHANGELOG.md` or `package-lock.json` versions)
4. **Sync CLAUDE.md version**: Update the `**Version**` line below to match the new version from `package.json`
5. **Commit and deploy**: `git add -A && git commit -m "chore: version packages" && git push && npm run build && systemctl --user restart codeman-web`
6. **Wait for CI**: after `git push`, find the run with `gh run list -L 1 --json databaseId,headBranch -q '.[0].databaseId'` and watch it with `gh run watch <id> --exit-status`. Confirm all checks pass before considering the release done.

CI runs `npm run check:lockfile` on every push/PR, so lockfile drift fails the build even if the `version-packages` script is bypassed.

**Version**: 0.6.7 (must match `package.json`)

## Project Overview

Codeman is a Claude Code session manager with web interface and autonomous Ralph Loop. Spawns Claude CLI via PTY, streams via SSE, supports respawn cycling for 24+ hour autonomous runs.

**Tech Stack**: TypeScript (ES2022/NodeNext, strict mode), Node.js, Fastify, node-pty, xterm.js. Supports both Claude Code and OpenCode AI CLIs via pluggable CLI resolvers.

**TypeScript Strictness** (see `tsconfig.json`): `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `allowUnreachableCode: false`, `allowUnusedLabels: false`.

**Requirements**: Node.js 18+, Claude CLI, tmux

**Git**: Main branch is `master`. SSH session chooser: `sc` (interactive), `sc 2` (quick attach), `sc -l` (list).

## Additional Commands

`npm run dev` = dev server. Default port: `3000`. Commands not in Quick Reference:

| Task | Command |
|------|---------|
| Dev with TLS | `npx tsx src/index.ts web --https` |
| Override window title hostname | `npx tsx src/index.ts web --title-hostname <name>` (default: `os.hostname()` — tab title renders as `codeman:<name>`) |
| Continuous typecheck | `tsc --noEmit --watch` |
| Test coverage | `npm run test:coverage` |
| Dead-code sweep | `npm run knip` (config in `knip.json`) |
| Production start | `npm run start` |
| Production logs | `journalctl --user -u codeman-web -f` |

**CI**: `.github/workflows/ci.yml` runs `check:lockfile`, `typecheck`, `lint`, `format:check` on push to master/main and on PRs (Node 22). Tests excluded (they spawn tmux).

**Code style**: Prettier (`singleQuote: true`, `printWidth: 120`, `trailingComma: "es5"`). ESLint flat config (`config/eslint.config.js`) allows `no-console`, warns on `@typescript-eslint/no-explicit-any`. Ignores: `app.js`, `scripts/**/*.mjs`, `src/web/public/vendor/**`, `scripts/remotion/**`.

## Common Gotchas

- **Single-line prompts only** — `writeViaMux()` sends text+Enter separately; multi-line breaks Ink
- **ESM only** — Never `require()`, use `await import()`. `tsx` masks CJS/ESM issues in dev but production breaks
- **Package ≠ product name** — npm: `aicodeman`, product: **Codeman**. Release renames tags accordingly
- **Global regex `lastIndex`** — Shared `g`-flag patterns in loops must reset `lastIndex = 0` first, or use the `execPattern()` helper in `utils/regex-patterns.ts` (resets automatically)
- **`envOverrides` flow `CLAUDE_CODE_*` / `OPENCODE_*` env vars** — Set via `POST /api/sessions { envOverrides }`, stored on `Session._envOverrides`, exported by `tmux-manager.buildEnvExports()` at spawn time, persisted in `SessionState.envOverrides`. **Do NOT** write these to `<case>/.claude/settings.local.json` — that's the old path and creates UI/disk drift
- **Zod `.optional()` rejects `null`** — accepts `undefined` only. When the frontend builds a request body with `JSON.stringify`, an explicit `null` field is preserved on the wire and fails validation with `INVALID_INPUT`. Convert `null` → `undefined` before stringifying (e.g. `field: value ?? undefined`), or declare the schema `.nullish()`. Real bugs caused: 0.6.4 (`durationMinutes` for ∞ respawn), and the same shape pattern hit `opusContext1mEnabled` in 0.6.3
- **`xterm-zerolag-input` is duplicated** — the local-echo overlay lives in BOTH `packages/xterm-zerolag-input/src/` (published package) AND inline inside `src/web/public/app.js` (runtime copy used by the web UI). Any change to overlay behavior MUST be applied to both, or dev and prod diverge. Always test on mobile after touching it.

**Import conventions**: Utils from `./utils`, types from `./types` (barrel), config from specific `./config/*` files.

## Architecture

### Core Files (by domain)

| Domain | Key files | Notes |
|--------|-----------|-------|
| **Entry** | `src/index.ts`, `src/cli.ts` | |
| **Session** | `src/session.ts` ★, `src/session-manager.ts`, `src/session-auto-ops.ts`, `src/session-cli-builder.ts`, `src/session-lifecycle-log.ts`, `src/session-task-cache.ts` | |
| **Mux** | `src/mux-interface.ts`, `src/mux-factory.ts`, `src/tmux-manager.ts` | |
| **Respawn** | `src/respawn-controller.ts` ★ + 4 helpers (`-adaptive-timing`, `-health`, `-metrics`, `-patterns`) | Read `docs/respawn-state-machine.md` first |
| **Ralph** | `src/ralph-tracker.ts` ★, `src/ralph-loop.ts` + 5 helpers (`-config`, `-fix-plan-watcher`, `-plan-tracker`, `-stall-detector`, `-status-parser`) | Read `docs/ralph-wiggum-guide.md` first |
| **Orchestrator** | `src/orchestrator-loop.ts`, `src/orchestrator-planner.ts`, `src/orchestrator-verifier.ts` | Read `docs/orchestrator-loop-architecture.md` first |
| **Agents** | `src/subagent-watcher.ts` ★, `src/team-watcher.ts`, `src/bash-tool-parser.ts`, `src/transcript-watcher.ts` | |
| **AI** | `src/ai-checker-base.ts`, `src/ai-idle-checker.ts`, `src/ai-plan-checker.ts` | |
| **Tasks** | `src/task.ts`, `src/task-queue.ts`, `src/task-tracker.ts` | |
| **State** | `src/state-store.ts`, `src/run-summary.ts`, `src/session-lifecycle-log.ts` | |
| **Infra** | `src/hooks-config.ts`, `src/push-store.ts`, `src/tunnel-manager.ts`, `src/image-watcher.ts`, `src/file-stream-manager.ts` | |
| **Plan** | `src/plan-orchestrator.ts`, `src/prompts/*.ts`, `src/templates/claude-md.ts` | |
| **Web** | `src/web/server.ts`, `src/web/sse-events.ts`, `src/web/routes/*.ts` (15 route modules + barrel), `src/web/route-helpers.ts`, `src/web/ports/*.ts`, `src/web/middleware/auth.ts`, `src/web/schemas.ts` | |
| **Frontend** | `src/web/public/app.js` (~2.9K lines, core) + 5 infra modules (`constants.js`, `mobile-handlers.js`, `voice-input.js`, `notification-manager.js`, `keyboard-accessory.js`) + 7 domain modules (`terminal-ui.js`, `respawn-ui.js`, `ralph-panel.js`, `orchestrator-panel.js`, `settings-ui.js`, `panels-ui.js`, `session-ui.js`) + 4 feature modules (`ralph-wizard.js`, `api-client.js`, `subagent-windows.js`, `input-cjk.js`) + `sw.js` | |
| **Types** | `src/types/index.ts` (barrel) → 14 domain files; also `src/types.ts` root re-export | See `@fileoverview` in index.ts |

★ = Large file (>50KB). All files have `@fileoverview` JSDoc — read that before diving in. Discovery aid: `grep -l '@fileoverview' src/web/routes/*.ts` lists all route modules; same grep works for `src/types/`, `src/web/public/*.js`.

**Local package**: `packages/xterm-zerolag-input/` — local echo overlay for xterm.js; copy embedded in `app.js`.

**Config**: `src/config/` — 9 files. Import from specific files, not barrel.

**Utilities**: `src/utils/` — re-exported via index. Key: `CleanupManager`, `LRUMap`, `StaleExpirationMap`, `BufferAccumulator`, `stripAnsi`, `Debouncer`, `KeyedDebouncer`. Also: `claude-cli-resolver`/`opencode-cli-resolver` (CLI path resolution), `string-similarity` (fuzzy matching), `regex-patterns` (ANSI/token/spinner patterns), `assertNever` (exhaustive checks), `token-validation` (auth tokens), `nice-wrapper` (process priority).

### Data Flow

1. Session spawns `claude --dangerously-skip-permissions` via node-pty
2. PTY output buffered, ANSI stripped, parsed for JSON messages
3. WebServer broadcasts to SSE clients at `/api/events`
4. State persists to `~/.codeman/state.json` via StateStore

### Key Patterns

**Input**: `session.writeViaMux()` for programmatic input — tmux `send-keys -l` (literal) + `send-keys Enter`. Single-line only.

**Idle detection**: Multi-layer (completion message → AI check → output silence → token stability). See `docs/respawn-state-machine.md`.

**Hook events**: Claude Code hooks trigger via `/api/hook-event`. Key events: `permission_prompt`, `elicitation_dialog`, `idle_prompt`, `stop`, `teammate_idle`, `task_completed`. See `src/hooks-config.ts`.

**Agent Teams**: `TeamWatcher` polls `~/.claude/teams/`, matches to sessions via `leadSessionId`. Teammates are in-process threads appearing as subagents. Enable: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. See `docs/agent-teams/`.

**Circuit breaker**: Prevents respawn thrashing. States: `CLOSED` → `HALF_OPEN` → `OPEN`. Reset: `/api/sessions/:id/ralph-circuit-breaker/reset`.

**Port interfaces**: Routes declare dependencies via port interfaces (`src/web/ports/`). Routes use intersection types (e.g., `SessionPort & EventPort`).

### Frontend

Frontend JS modules have `@fileoverview` with `@dependency`/`@loadorder` tags. Load order: `constants.js`(1) → `mobile-handlers.js`(2) → `voice-input.js`(3) → `notification-manager.js`(4) → `keyboard-accessory.js`(5) → `input-cjk.js`(5.5) → `app.js`(6) → `terminal-ui.js`(7) → `respawn-ui.js`(8) → `ralph-panel.js`(9) → `orchestrator-panel.js`(9.5) → `settings-ui.js`(10) → `panels-ui.js`(11) → `session-ui.js`(12) → `ralph-wizard.js`(13) → `api-client.js`(14) → `subagent-windows.js`(15). `input-cjk.js` handles CJK IME composition via an always-visible textarea below the terminal (`window.cjkActive` blocks xterm's onData).

**Z-index layers**: subagent windows (1000), plan agents (1100), log viewers (2000), image popups (3000), local echo overlay (7).

**Respawn presets**: `solo-work` (3s/60min), `subagent-workflow` (45s/240min), `team-lead` (90s/480min), `ralph-todo` (8s/480min), `overnight-autonomous` (10s/480min).

**Keyboard shortcuts**: Escape (close), Ctrl+? (help), Ctrl+W (kill), Ctrl+Tab (next), Alt+1-9 (switch tab), Ctrl+Shift+{/} (move tab left/right), Shift+Enter (newline), Ctrl+L (clear), Ctrl+Shift+R (restore size), Ctrl+Shift+V (voice input), Ctrl/Cmd +/- (font).

### Security

| Layer | Details |
|-------|---------|
| **Auth** | Optional HTTP Basic via `CODEMAN_USERNAME`/`CODEMAN_PASSWORD` env vars |
| **QR Auth** | Single-use 6-char tokens (60s TTL) for tunnel login. See `docs/qr-auth-plan.md` |
| **Sessions** | 24h cookie (`codeman_session`), auto-extend, device context audit |
| **Rate limit** | 10 failed auth/IP → 429 (15min decay). QR has separate limiter |
| **Hook bypass** | `/api/hook-event` exempt from auth (localhost-only, schema-validated) |
| **Env vars** | `CODEMAN_MUX` (managed session), `CODEMAN_API_URL` (auto-set for hooks) |
| **Validation** | Zod schemas, path allowlist regex, `CLAUDE_CODE_*` env prefix allowlist |
| **Headers** | CORS localhost-only, CSP, X-Frame-Options, HSTS if HTTPS |

### SSE Event Registry

~120 event types in `src/web/sse-events.ts` (backend) and `SSE_EVENTS` in `constants.js` (frontend). Both must be kept in sync.

### API Routes

~128 handlers across 15 route files in `src/web/routes/`: system (36), sessions (27), orchestrator (10), cases (9), ralph (9), plan (8), respawn (7), files (5), mux (5), push (4), scheduled (4), teams (2), hooks (1), clipboard (1), ws (1 WebSocket). Each file has `@fileoverview` with endpoint details.

## Adding Features

- **API endpoint**: Types in `src/types/` domain file, route in `src/web/routes/*-routes.ts`, use `createErrorResponse()`. Validate with Zod schemas in `schemas.ts`.
- **SSE event**: Add to `src/web/sse-events.ts` + `SSE_EVENTS` in `constants.js`, emit via `broadcast()`, handle in `app.js` (`addListener(`)
- **Session setting**: Add to `SessionState`, include in `session.toState()`, call `persistSessionState()`
- **Hook event**: Add to `HookEventType`, add hook in `hooks-config.ts:generateHooksConfig()`, update `HookEventSchema`
- **Mobile feature**: Add to relevant singleton, guard with `MobileDetection.isMobile()`
- **New test**: Pick unique port (search `const PORT =`). Route tests use `app.inject()` (no port needed) — see `test/routes/_route-test-utils.ts`.

**Validation**: Zod v4 (different API from v3). Define schemas in `schemas.ts`, use `.parse()`/`.safeParse()`.

## State Files

All in `~/.codeman/`: `state.json` (sessions, settings, respawn), `mux-sessions.json` (tmux recovery), `settings.json` (user prefs), `push-keys.json` (VAPID), `push-subscriptions.json`, `session-lifecycle.jsonl` (audit log).

## Testing

**CRITICAL: You are running inside a Codeman-managed tmux session.** Never run `npx vitest run` (full suite) — it spawns/kills tmux sessions and will crash your own session. Only run individual files:

```bash
npm test -- test/<specific-file>.test.ts         # Single file (SAFE, uses config/vitest.config.ts)
npm test -- -t "pattern"                          # By name (SAFE)
# npm test                                        # DANGEROUS — runs full suite, DON'T DO THIS
```

Raw `npx vitest` skips `config/vitest.config.ts`; always use `npm test --` or pass `--config config/vitest.config.ts`.

**Config**: Vitest with `globals: true`, `fileParallelism: false`. Timeout 30s, teardown 60s.

**Safety**: `test/setup.ts` snapshots pre-existing tmux sessions and never kills them. Only `registerTestTmuxSession()` sessions get cleaned up.

**Ports**: Pick unique ports manually. Search `const PORT =` before adding new tests.

**Respawn tests**: Use `MockSession` from `test/respawn-test-utils.ts`. **Route tests**: `app.inject()` in `test/routes/`. **Mobile tests**: Playwright suite in `test/mobile/` (135 device profiles).

## Debugging

```bash
tmux list-sessions                                 # List tmux sessions
curl localhost:3000/api/sessions | jq              # Check sessions
curl localhost:3000/api/status | jq                # Full app state
curl localhost:3000/api/subagents | jq             # Background agents
cat ~/.codeman/state.json | jq                     # Persisted state
```

Mobile screenshots: `~/.codeman/screenshots/`, accessed via `GET/POST /api/screenshots`.

## Performance & Limits

Target: 20 sessions, 50 agent windows at 60fps. Limits in `src/config/`: terminal 2MB, text 1MB, messages 1000, max agents 500, max sessions 50, max SSE clients 100. Use `LRUMap` for bounded caches, `StaleExpirationMap` for TTL cleanup. Anti-flicker pipeline: `docs/terminal-anti-flicker.md`.

**Memory leaks (24+ hour sessions)**: use `CleanupManager`, clear Maps in `stop()`, guard async with `if (this.cleanup.isStopped) return`. Frontend: store handler refs, clean in `close*()`. Verify: `npm test -- test/memory-leak-prevention.test.ts`.

## Scripts & Tunnel

Key scripts: `scripts/tmux-manager.sh` (safe tmux mgmt), `scripts/tunnel.sh start|stop|url` (tunnel). Production services: `scripts/codeman-web.service`, `scripts/codeman-tunnel.service`. **Always set `CODEMAN_PASSWORD`** before exposing via tunnel.
