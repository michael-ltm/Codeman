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

The production server caches static files for 1 year, `immutable` (`maxAge: '1y'` in `server.ts`). To avoid stale frontend after a deploy, `renderIndexHtml` runs `cacheBustAssets(html)` — it appends `?v=<mtime>` to **every same-origin `.js`/`.css`** reference (mtime memoized ~1s so a burst of renders is cheap; external/already-versioned/missing refs untouched). Because `index.html` is served `no-cache`, a **normal reload now picks up edited modules/styles — no hard refresh needed** (the gesture bundle is injected separately with its own `?v=`). If you add an asset referenced by an *absolute* URL or from JS rather than a `<script>/<link>` tag, it won't be auto-busted.

## COM Shorthand (Deployment)

Uses [Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`) via `@changesets/cli`. What SemVer actually covers (the CLI + documented env vars are public; the HTTP/SSE API, on-disk state, and experimental features are internal/unstable) is defined in `docs/versioning-policy.md`. Security reporting + known limitations live in `SECURITY.md`.

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

**Version**: 0.9.7 (must match `package.json`)

## Project Overview

Codeman is a Claude Code session manager with web interface and autonomous Ralph Loop. Spawns Claude CLI via PTY, streams via SSE, supports respawn cycling for 24+ hour autonomous runs.

**Tech Stack**: TypeScript (ES2022/NodeNext, strict mode), Node.js, Fastify, node-pty, xterm.js. Supports both Claude Code and OpenCode AI CLIs via pluggable CLI resolvers.

**TypeScript Strictness** (see `tsconfig.json`): `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `allowUnreachableCode: false`, `allowUnusedLabels: false`.

**Requirements**: Node.js 22+, Claude CLI, tmux

**Git**: Main branch is `master`. SSH session chooser: `sc` (interactive), `sc 2` (quick attach), `sc -l` (list).

## Additional Commands

`npm run dev` = dev server. Default port: `3000` (override with `--port` or the `CODEMAN_PORT` env var). To run this beta isolated alongside a prod Codeman, use `scripts/run-beta.sh` (sets `CODEMAN_INSTANCE=beta` + `CODEMAN_PORT=5000`). Commands not in Quick Reference:

| Task | Command |
|------|---------|
| Dev with TLS | `npx tsx src/index.ts web --https` |
| Override window title hostname | `npx tsx src/index.ts web --title-hostname <name>` (default: `os.hostname()` — `codeman:<name>` is used for tab title, title-flash, and OS desktop notification prefix) |
| Bind a non-loopback host | `npx tsx src/index.ts web --host 0.0.0.0` (or `-H`; env `CODEMAN_HOST`; default `127.0.0.1`). Without `CODEMAN_PASSWORD` it **starts but warns loudly** — see Common Gotchas + `docs/security-architecture.md` |
| Continuous typecheck | `tsc --noEmit --watch` |
| Test coverage | `npm run test:coverage` |
| Dead-code sweep | `npm run knip` (config in `knip.json`) |
| Rebuild gesture overlay | `npm run build:gesture` (esbuild `packages/gesture-control/src/codeman/entry.ts` → `src/web/public/gesture/gesture-codeman.js`; commit the result) |
| Gesture playground | `npm run dev` **in** `packages/gesture-control/` (standalone vite demo, fake tabs) |
| Check public-asset formatting | `npm run check:public-assets` (prettier-checks `src/web/public/**` text assets; `scripts/check-public-assets.mjs`) |
| Production start | `npm run start` |
| Production logs | `journalctl --user -u codeman-web -f` |

**CI**: `.github/workflows/ci.yml` runs `check:lockfile`, `typecheck`, `lint`, `format:check`, then a **server boot smoke test** (`tsx src/index.ts web --port 3151` must answer `/api/status` within 30s) on push to master/main and on PRs (Node 22). The unit test suite is excluded (it spawns tmux).

**Code style**: Prettier (`singleQuote: true`, `printWidth: 120`, `trailingComma: "es5"`). ESLint flat config (`config/eslint.config.js`) allows `no-console`, warns on `@typescript-eslint/no-explicit-any`. Ignores: `app.js`, `scripts/**/*.mjs`, `src/web/public/vendor/**`, `scripts/remotion/**`.

## Common Gotchas

- **Single-line prompts only** — `writeViaMux()` sends text+Enter separately; multi-line breaks Ink
- **ESM only** — Never `require()`, use `await import()`. `tsx` masks CJS/ESM issues in dev but production breaks
- **Package ≠ product name** — npm: `aicodeman`, product: **Codeman**. Release renames tags accordingly
- **Global regex `lastIndex`** — Shared `g`-flag patterns in loops must reset `lastIndex = 0` first, or use the `execPattern()` helper in `utils/regex-patterns.ts` (resets automatically)
- **`envOverrides` flow `CLAUDE_CODE_*` / `OPENCODE_*` env vars** — Set via `POST /api/sessions { envOverrides }`, stored on `Session._envOverrides`, exported by `tmux-manager.buildEnvExports()` at spawn time, persisted in `SessionState.envOverrides`. **Do NOT** write these to `<case>/.claude/settings.local.json` — that's the old path and creates UI/disk drift
- **Effort is NOT an env var** — never carry effort as `CLAUDE_CODE_EFFORT_LEVEL`: the env var hard-locks effort and blocks in-session `/effort` switching (incl. ultracode). It flows as the dedicated `effort` payload field → `Session._effort` → `claude --effort <level>` for regular levels incl. `max` (the settings `effortLevel` key is `enum(["low","medium","high","xhigh"]).catch(undefined)` — `max` gets SILENTLY dropped there), or `claude --settings '{"ultracode":true}'` for ultracode (rejected by `--effort`). Both are soft defaults the user can override anytime. Legacy env-var entries are auto-migrated by the Session constructor and unset from tmux sessions in `applyEnvOverrides()`. See `buildEffortCliArgs()` in `session-cli-builder.ts`, tests in `test/effort-injection.test.ts`
- **Dual-CLI prefix discipline** — Codeman supports both Claude Code and OpenCode (`claude-cli-resolver.ts` / `opencode-cli-resolver.ts`); env-var prefix is CLI-specific (`CLAUDE_CODE_*` vs `OPENCODE_*`) and the allowlist in `schemas.ts` enforces this. When adding settings, decide which CLI(s) it applies to and gate the env export accordingly — don't blindly forward both prefixes. See `docs/opencode-integration.md` for the OpenCode resolver design
- **Zod `.optional()` rejects `null`** — accepts `undefined` only. When the frontend builds a request body with `JSON.stringify`, an explicit `null` field is preserved on the wire and fails validation with `INVALID_INPUT`. Convert `null` → `undefined` before stringifying (e.g. `field: value ?? undefined`), or declare the schema `.nullish()`. Real bugs caused: 0.6.4 (`durationMinutes` for ∞ respawn), and the same shape pattern hit `opusContext1mEnabled` in 0.6.3
- **`xterm-zerolag-input` is single-source — edit the package, then rebuild the bundle** — the local-echo overlay source lives ONLY in `packages/xterm-zerolag-input/src/` (`zerolag-input-addon.ts`; also published to npm as a standalone library — see README "Published Packages"). It is bundled (esbuild → IIFE, with appended `window.LocalEchoOverlay` aliases) into the **gitignored** `src/web/public/vendor/xterm-zerolag-input.js` by `scripts/postinstall.js` (for dev/`tsx`) and into `dist/.../vendor/` by `scripts/build.mjs:50` (for prod). `app.js` only **consumes** it via `new LocalEchoOverlay(terminal)` — there is NO inline copy to keep in sync. So: change behavior in the package source, then re-run the bundle step (`npm install` reruns postinstall; `npm run build` for prod); **never hand-edit `app.js` for overlay behavior or commit the gitignored vendor bundle**. A public-API break in the package still warrants a separate `xterm-zerolag-input` version bump in the changeset. Always test on mobile after touching it. See `docs/local-echo-overlay-plan.md`.
- **Default bind is loopback-only; non-loopback without a password starts but warns** — since COD-29 (PR #107) the web server defaults to `--host 127.0.0.1` (was `0.0.0.0`). As of **0.9.0** binding a non-loopback host (`--host`/`-H`/`CODEMAN_HOST`) without `CODEMAN_PASSWORD` **no longer refuses to start — it starts and prints a loud warning** listing the fixes (set `CODEMAN_PASSWORD`, bind loopback + tunnel/`tailscale serve`, or `--allow-unauthenticated-network` / `CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK=1` to acknowledge → terser note). Host classification is `isLoopbackBindHost()` in `network-auth-policy.ts`; the warn-vs-start logic is in `server.ts` `start()`; flags wired in `cli.ts`. ⚠️ Operational note: the production systemd unit runs `node dist/index.js web --https` with no `--host`, so it binds **localhost only** — reach it remotely via `tailscale serve`/tunnel to `127.0.0.1`, or add `Environment=CODEMAN_HOST=0.0.0.0` + `Environment=CODEMAN_PASSWORD=…` to `~/.config/systemd/user/codeman-web.service`. A loopback bind is reachable through a same-host tunnel (cloudflared/tailscale → `127.0.0.1`) but NOT by a browser hitting the box's LAN IP. Auth user defaults to `admin`. **Full model: `docs/security-architecture.md`.**
- **Instance isolation / multi-instance attach danger** — data dir (`~/.codeman`) and tmux socket (`tmux -L codeman`) are PROCESS-WIDE and shared by every Codeman on the machine, derived from `CODEMAN_INSTANCE` via `src/config/instance.ts` (`getDataDir()`/`dataPath()`/`DEFAULT_TMUX_SOCKET`). ⚠️ A 2nd instance on the SAME socket **discovers and attaches PTYs to the first instance's live sessions** (`tmux -L codeman attach-session …`), resizing/mutating them — `$HOME` isolation is NOT enough (tmux is system-global). To run two instances, give each a distinct `CODEMAN_INSTANCE` (scopes BOTH dir+socket: `~/.codeman-<name>` + `-L codeman-<name>`), or set `CODEMAN_TMUX_SOCKET` + `CODEMAN_DATA_DIR` individually. **`CODEMAN_INSTANCE` defaults to empty = the production layout (`~/.codeman`, `-L codeman`, port 3000)**, so this branch is safe to ship to master without disturbing existing installs. To run THIS beta alongside prod, launch with `scripts/run-beta.sh` (`CODEMAN_INSTANCE=beta` + `CODEMAN_PORT=5000`) — it never collides with prod's data dir/socket/port. Any new `~/.codeman/...` path MUST go through `dataPath()`, never `join(homedir(), '.codeman', …)`.

**Import conventions**: Utils from `./utils`, types from `./types` (barrel), config from specific `./config/*` files.

## Architecture

### Core Files (by domain)

| Domain | Key files | Notes |
|--------|-----------|-------|
| **Entry** | `src/index.ts`, `src/cli.ts` | |
| **Session** | `src/session.ts` ★, `src/session-manager.ts`, `src/session-auto-ops.ts`, `src/session-cli-builder.ts`, `src/session-lifecycle-log.ts`, `src/session-task-cache.ts` | |
| **Mux** | `src/mux-interface.ts`, `src/mux-factory.ts`, `src/tmux-manager.ts` ★ | |
| **Respawn** | `src/respawn-controller.ts` ★ + 4 helpers (`-adaptive-timing`, `-health`, `-metrics`, `-patterns`) | Read `docs/respawn-state-machine.md` first |
| **Ralph** | `src/ralph-tracker.ts` ★, `src/ralph-loop.ts` + 5 helpers (`-config`, `-fix-plan-watcher`, `-plan-tracker`, `-stall-detector`, `-status-parser`) | Read `docs/ralph-wiggum-guide.md` first |
| **Orchestrator** | `src/orchestrator-loop.ts`, `src/orchestrator-planner.ts`, `src/orchestrator-verifier.ts` | Read `docs/orchestrator-loop-architecture.md` first |
| **Agents** | `src/subagent-watcher.ts` ★, `src/team-watcher.ts`, `src/bash-tool-parser.ts`, `src/transcript-watcher.ts` | |
| **AI** | `src/ai-checker-base.ts`, `src/ai-idle-checker.ts`, `src/ai-plan-checker.ts` | |
| **Tasks** | `src/task.ts`, `src/task-queue.ts`, `src/task-tracker.ts` | |
| **State** | `src/state-store.ts`, `src/run-summary.ts`, `src/session-lifecycle-log.ts` | |
| **Infra** | `src/hooks-config.ts`, `src/push-store.ts`, `src/tunnel-manager.ts`, `src/image-watcher.ts`, `src/file-stream-manager.ts` | |
| **Plan** | `src/plan-orchestrator.ts`, `src/prompts/*.ts`, `src/templates/claude-md.ts` | |
| **Web** | `src/web/server.ts` ★, `src/web/sse-events.ts`, `src/web/routes/*.ts` (15 route modules + barrel; `session-routes.ts` ★), `src/web/route-helpers.ts`, `src/web/ports/*.ts`, `src/web/middleware/auth.ts`, `src/web/schemas.ts`, `src/web/self-update.ts` | |
| **Frontend** | `src/web/public/app.js` (~3.4K lines, core) + 5 infra modules (`constants.js`, `mobile-handlers.js`, `voice-input.js`, `notification-manager.js`, `keyboard-accessory.js`) + 7 domain modules (`terminal-ui.js`, `respawn-ui.js`, `ralph-panel.js`, `orchestrator-panel.js`, `settings-ui.js`, `panels-ui.js`, `session-ui.js`) + 5 feature modules (`ralph-wizard.js`, `api-client.js`, `subagent-windows.js`, `input-cjk.js`, `image-input.js`) + `sw.js` | |
| **Types** | `src/types/index.ts` (barrel) → 15 domain files; also `src/types.ts` root re-export | See `@fileoverview` in index.ts |

★ = Large, central file (>50KB) — read its `@fileoverview` first. All files have `@fileoverview` JSDoc — read that before diving in. Discovery aid: `grep -l '@fileoverview' src/web/routes/*.ts` lists all route modules; same grep works for `src/types/`, `src/web/public/*.js`.

**Local packages**: `packages/xterm-zerolag-input/` — local echo overlay for xterm.js; copy embedded in `app.js`. `packages/gesture-control/` (`codeman-gesture-control`) — hand-tracking overlay source; built to `src/web/public/gesture/gesture-codeman.js` via `npm run build:gesture` (see Frontend → Gesture control).

**Config**: `src/config/` — 10 files. Import from specific files, not barrel.

**Utilities**: `src/utils/` — re-exported via index. Key: `CleanupManager`, `LRUMap`, `StaleExpirationMap`, `BufferAccumulator`, `stripAnsi`, `Debouncer`, `KeyedDebouncer`. Also: `claude-cli-resolver`/`opencode-cli-resolver` (CLI path resolution), `string-similarity` (fuzzy matching), `regex-patterns` (ANSI/token/spinner patterns), `assertNever` (exhaustive checks), `token-validation` (auth tokens), `nice-wrapper` (process priority).

### Data Flow

1. Session spawns `claude --dangerously-skip-permissions` via node-pty
2. PTY output buffered, ANSI stripped, parsed for JSON messages
3. WebServer broadcasts to SSE clients at `/api/events`
4. State persists to `~/.codeman/state.json` via StateStore

### Key Patterns

**Input**: `session.writeViaMux()` for programmatic input — tmux `send-keys -l` (literal) + `send-keys Enter`. Single-line only.

**Idle detection**: Multi-layer (completion message → AI check → output silence → token stability). See `docs/respawn-state-machine.md`.

**Orchestrator**: State machine that turns a user goal into a phased plan and drives it to completion: `idle → planning → approval → executing → verifying → (replanning) → completed/failed`. `OrchestratorLoop` (engine) delegates plan generation to `orchestrator-planner` and per-phase verification gates to `orchestrator-verifier`, executing phases via team agents/`task-queue`. State persists under the `orchestrator` key in `state.json`. Distinct from Ralph (single-session autonomous loop) — orchestrator coordinates multi-phase, multi-agent execution. See `docs/orchestrator-loop-architecture.md`.

**Hook events**: Claude Code hooks trigger via `/api/hook-event`. Key events: `permission_prompt`, `elicitation_dialog`, `idle_prompt`, `stop`, `teammate_idle`, `task_completed`. See `src/hooks-config.ts`.

**Agent Teams**: `TeamWatcher` polls `~/.claude/teams/`, matches to sessions via `leadSessionId`. Teammates are in-process threads appearing as subagents. Enable: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. See `docs/agent-teams/`.

**Circuit breaker**: Prevents respawn thrashing. States: `CLOSED` → `HALF_OPEN` → `OPEN`. Reset: `/api/sessions/:id/ralph-circuit-breaker/reset`.

**Self-update** (App Settings → Updates): in-app updater for **git-clone installs** supervised by systemd/launchd. The update restarts the very process running it, so the real work runs in a DETACHED `scripts/self-update.sh` (`git checkout <release tag> && npm install && npm run build && restart`) that outlives the restart; it writes progress to `dataPath('update-status.json')`, which the browser polls across the connection drop. Channel = latest `codeman@X.Y.Z` release tag; dirty trees are auto-stashed. `src/web/self-update.ts` splits PURE helpers (semver/tag parsing, reconcile decision — unit-tested) from IO wrappers (`getInstallInfo`/`checkForUpdate`/`startUpdate`/`reconcileUpdateOnBoot`). Routes: `GET /api/system/update/check`, `POST /api/system/update`, `GET /api/system/update/status`. Types: `src/types/update.ts`. npm installs report as non-updatable.

**Port interfaces**: Routes declare dependencies via port interfaces (`src/web/ports/`). Routes use intersection types (e.g., `SessionPort & EventPort`).

### Frontend

Frontend JS modules have `@fileoverview` with `@dependency`/`@loadorder` tags. Load order: `constants.js`(1) → `mobile-handlers.js`(2) → `voice-input.js`(3) → `notification-manager.js`(4) → `keyboard-accessory.js`(5) → `input-cjk.js`(5.5) → `app.js`(6) → `terminal-ui.js`(7) → `respawn-ui.js`(8) → `ralph-panel.js`(9) → `orchestrator-panel.js`(9.5) → `settings-ui.js`(10) → `panels-ui.js`(11) → `session-ui.js`(12) → `ralph-wizard.js`(13) → `api-client.js`(14) → `subagent-windows.js`(15) → `image-input.js`(16). `input-cjk.js` handles CJK IME composition via an always-visible textarea below the terminal (`window.cjkActive` blocks xterm's onData).

**Z-index layers**: subagent windows (1000), plan agents (1100), log viewers (2000), image popups (3000), local echo overlay (7).

**Multi-monitor button** (header, top-right; the notification bell it sits beside stays hidden — notifications live in Settings → Notifications). `app.launchMultiMonitor()` (in `panels-ui.js`) POSTs `/api/system/span-displays`, which spawns `scripts/span-codeman.sh` — a fresh, maximized browser `--app` window sized to the union of all displays (macOS; needs "Displays have separate Spaces" OFF). Supports the gesture layer's in-page floating session panels dragging across the physical monitor seam. **Opt-in:** hidden by default; enable under App Settings → Display → **Header Displays** ("Multi-monitor Button", `showMultiMonitorButton`). The button carries a `btn-multimonitor--hidden` class in the template; `renderIndexHtml` strips that class at render when the setting is on (a unique class token, not a brittle match on the aria-label/style copy), and `applyHeaderVisibilitySettings()` toggles the same class live on save. Solo (detached) windows hide it via `body.solo-mode`.

**Gesture control** (the camera hand-tracking overlay) is **opt-in, default OFF**, under App Settings → Display → **Input** (`gestureControlEnabled`). `CODEMAN_GESTURE=1` makes the feature *available* on the instance (CSP widening + `/gesture/` assets) and sets `window.__codemanGestureAvailable` (the Input section only shows when set); the overlay bundle is injected by `renderIndexHtml` **only when the setting is enabled**, so that method is `async` and reads `settings.json` via `readSettings(true)` — the `true` forces a **fresh** read (bypassing the 2s `_settingsCache`), because a post-save reload happens within that TTL and the cached value would otherwise render the pre-toggle state. Toggling the setting reloads the page (the bundle is render-injected).

**Gesture-control source lives in-repo** at `packages/gesture-control/` (workspace package `codeman-gesture-control`, was the standalone `Ark0N/codeman-gesture-control` repo). The transport-agnostic core is `src/gesture/*` (MediaPipe GestureRecognizer → One-Euro-filtered cursor → pinch state machine); `src/codeman/entry.ts` is the Codeman *consumer* that maps grab/drag/drop onto real `.session-tab`/toolbar buttons and is the bundle entry. **Edit there, then run `npm run build:gesture`** (`scripts/build-gesture-bundle.mjs` → esbuild bundles `entry.ts`, MediaPipe JS included, into `src/web/public/gesture/gesture-codeman.js`) and **commit the regenerated bundle** — the committed bundle is what dev/`tsx` serves (no bundler at runtime), and `scripts/build.mjs` reruns the same step so prod always reflects current source. The MediaPipe **wasm + model** are NOT bundled — loaded at runtime from same-origin `/gesture/wasm` + `/gesture/gesture_recognizer.task`, fetched by `scripts/fetch-gesture-assets.mjs` (gitignored, see Gotchas). `entry.ts` mounts `window.__codemanGesture = new GestureBridge()` idempotently at module-eval. A standalone vite playground (`npm run dev` in the package — fake tabs, no Codeman) lets you iterate on gesture *feel* in isolation. ⚠️ Keep `MP_VERSION` in `fetch-gesture-assets.mjs` in sync with `@mediapipe/tasks-vision` in `packages/gesture-control/package.json`.

**Respawn presets**: `solo-work` (3s/60min), `subagent-workflow` (45s/240min), `team-lead` (90s/480min), `ralph-todo` (8s/480min), `overnight-autonomous` (10s/480min).

**Keyboard shortcuts**: Escape (close), Ctrl+? (help), Ctrl+W (kill), Ctrl+Tab (next), Alt+1-9 (switch tab), Ctrl+Shift+{/} (move tab left/right), Shift+Enter (newline), Ctrl+L (clear), Ctrl+Shift+R (restore size), Ctrl+Shift+V (voice input), Ctrl/Cmd +/- (font).

### Security

**Full model: [`docs/security-architecture.md`](docs/security-architecture.md)** — network binding, auth pipeline, the tunnel caveat, file-serving hardening, supply-chain, instance isolation, and recommended secure setups.

| Layer | Details |
|-------|---------|
| **Auth** | Optional HTTP Basic via `CODEMAN_USERNAME` (defaults to `admin`) / `CODEMAN_PASSWORD` env vars. Active only when `CODEMAN_PASSWORD` is set (`middleware/auth.ts`) |
| **Network bind** | Defaults to `127.0.0.1` (loopback). A non-loopback bind (`--host`/`CODEMAN_HOST`) without `CODEMAN_PASSWORD` **starts but warns loudly** (0.9.0; was fail-closed in COD-29/#107). `--allow-unauthenticated-network` / `CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK=1` acknowledges the warning. Classifier: `network-auth-policy.ts` |
| **Host guard** | Always-on Host-header allowlist blocks DNS rebinding (RCE on the default no-auth loopback install). Allows loopback, any IP literal, the bind host, `*.ts.net`/`*.trycloudflare.com`/`*.cfargotunnel.com`, the active managed tunnel, and `CODEMAN_ALLOWED_HOSTS`. ⚠️ **Custom reverse-proxy domains are rejected** unless added via `CODEMAN_ALLOWED_HOSTS=host,.suffix`. `registerHostGuard` in `server.ts`; policy in `network-auth-policy.ts` (`buildHostPolicy`/`isAllowedRequestHost`/`isAllowedRequestOrigin`) |
| **CSRF / Origin** | Always-on cross-site Origin guard rejects state-changing requests from foreign origins (covers self-update, session create/input, settings/tunnel toggles). **A missing Origin is allowed** so curl/CLI and Claude Code hooks keep working. The global body parser keeps `text/plain` RAW (no auto-JSON-parse, which had enabled simple-request CSRF); `/api/crash-diag` self-parses. WebSocket upgrade validates Origin+Host (anti-CSWSH) in `ws-routes.ts`. Added in `c669518` (closes 2026-06-09 review CRITICALs) |
| **QR Auth** | Single-use 6-char tokens (60s TTL) for tunnel login. See `docs/qr-auth-plan.md` |
| **Sessions** | 24h cookie (`codeman_session`), auto-extend, device context audit |
| **Rate limit** | 10 failed auth/IP → 429 (15min decay). QR has separate limiter |
| **Hook bypass** | `/api/hook-event` exempt from auth (localhost-only, schema-validated) |
| **Env vars** | `CODEMAN_MUX` (managed session), `CODEMAN_API_URL` (auto-set for hooks), `CODEMAN_ALLOWED_HOSTS` (extra Host/Origin allowlist entries for reverse proxies, comma-separated; bare `.suffix` matches subdomains) |
| **Validation** | Zod schemas, path allowlist regex, `CLAUDE_CODE_*` env prefix allowlist |
| **Headers** | CORS localhost-only, CSP, X-Frame-Options, HSTS if HTTPS |

### SSE Event Registry

~120 event types in `src/web/sse-events.ts` (backend) and `SSE_EVENTS` in `constants.js` (frontend). Both must be kept in sync.

### API Routes

~134 handlers across 15 route files in `src/web/routes/`: system (40, incl. self-update `check`/`status`/`POST /api/system/update` + `POST /api/system/span-displays` → spawns `scripts/span-codeman.sh`), sessions (28), orchestrator (10), cases (9), ralph (9), plan (8), respawn (7), files (6), mux (5), push (4), scheduled (4), teams (2), hooks (1), clipboard (1), ws (1 WebSocket). Each file has `@fileoverview` with endpoint details.

## Adding Features

- **API endpoint**: Types in `src/types/` domain file, route in `src/web/routes/*-routes.ts`, use `createErrorResponse()`. Validate with Zod schemas in `schemas.ts`.
- **SSE event**: Add to `src/web/sse-events.ts` + `SSE_EVENTS` in `constants.js`, emit via `broadcast()`, handle in `app.js` (`addListener(`)
- **Session setting**: Add to `SessionState`, include in `session.toState()`, call `persistSessionState()`
- **Hook event**: Add to `HookEventType`, add hook in `hooks-config.ts:generateHooksConfig()`, update `HookEventSchema`
- **Mobile feature**: Add to relevant singleton, guard with `MobileDetection.isMobile()`
- **New test**: Pick unique port (search `const PORT =`). Route tests use `app.inject()` (no port needed) — see `test/routes/_route-test-utils.ts`.

**Validation**: Zod v4 (different API from v3). Define schemas in `schemas.ts`, use `.parse()`/`.safeParse()`.

## State Files

All in `~/.codeman/`: `state.json` (sessions, settings, respawn), `mux-sessions.json` (tmux recovery), `settings.json` (user prefs), `push-keys.json` (VAPID), `push-subscriptions.json`, `session-lifecycle.jsonl` (audit log), `update-status.json` (self-updater progress, polled across the service restart).

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

**Respawn tests**: Use `MockSession` from `test/respawn-test-utils.ts`. **Route tests**: `app.inject({ method, url, payload })` in `test/routes/` — no live port needed. **Mobile tests**: Playwright suite in `test/mobile/` (135 device profiles).

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
