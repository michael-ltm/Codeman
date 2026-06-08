# aicodeman

## 0.9.3

### Patch Changes

- Installer security notice + clarify gesture control stays opt-in and default-off.
  - **Installer:** `install.sh` now prints the network-security notice as the final block of both the fresh install (one-line `curl … | bash`) and the update flow, so it stays visible to the user: Codeman binds `127.0.0.1` by default (no password needed), and the safe ways to reach it remotely (`tailscale serve` / tunnel, or `--host 0.0.0.0` + `CODEMAN_PASSWORD`), noting a non-loopback bind without a password still starts but warns loudly.
  - **Gesture control** is **disabled by default** and is enabled only by the per-user toggle at App Settings → Display → Input → Gesture Control (`gestureControlEnabled`, default `false`). Setting `CODEMAN_GESTURE=1` on the server only makes the feature _available_ (CSP widening + same-origin `/gesture/` assets); it does **not** turn the overlay on. There is no default-on path — the bundle is injected only when a user explicitly enables the setting.

## 0.9.2

### Patch Changes

- Vendor the gesture-control source into the repo for in-tree development.

  The hand-tracking overlay's source (previously the standalone `Ark0N/codeman-gesture-control` repo) now lives at `packages/gesture-control/` as the `codeman-gesture-control` workspace package: the transport-agnostic gesture core (`src/gesture/*` — MediaPipe GestureRecognizer → One-Euro-filtered cursor → pinch state machine), the Codeman consumer entry (`src/codeman/entry.ts`, maps grab/drag/drop onto real session tabs + toolbar buttons), and a standalone vite playground for iterating on gesture feel.
  - New `npm run build:gesture` (`scripts/build-gesture-bundle.mjs`) esbuild-bundles `entry.ts` into the served `src/web/public/gesture/gesture-codeman.js`; `scripts/build.mjs` now reruns it on every production build so the served bundle always reflects current source. The MediaPipe wasm + model stay runtime-loaded from same-origin `/gesture/` (unchanged).
  - Added `@mediapipe/tasks-vision@0.10.21` as the package dependency (kept in sync with `fetch-gesture-assets.mjs`). The playground uses vite 7 (no known advisories).

  No change to the shipped app behavior — gesture control remains opt-in (`CODEMAN_GESTURE=1` + the App Settings → Input toggle). This release just makes the overlay developable inside the Codeman repo.

## 0.9.1

### Patch Changes

- Multi-monitor & settings UX fixes.
  - **Multi-monitor button (remote servers):** the "span displays" button spawns `scripts/span-codeman.sh` server-side, so on a non-macOS Codeman server it can't open a window on your machine. The non-macOS API error now explains this and points to running the script locally on your Mac with the remote server URL; the script header documents the same remote-client workflow.
  - **App Settings modal:** stop the modal overflowing horizontally on narrow viewports.
  - **systemd:** sync the `codeman-web.service` template with the deployed unit.

## 0.9.0

### Minor Changes

- Security hardening release: network-bind policy, auth lockout recovery, download/SVG hardening, dependency & supply-chain fixes, tmux launch reliability, and a full security-architecture doc.

  **Network binding (COD-29, #107):**
  - The web server now defaults to binding `127.0.0.1` (loopback) instead of `0.0.0.0`, so a fresh install is reachable only from the same machine and needs no password. New `--host` / `-H` / `CODEMAN_HOST` flag to choose the bind host.
  - Binding a non-loopback host **without** `CODEMAN_PASSWORD` no longer refuses to start — it **starts and prints a loud warning** with the three ways to secure it (set `CODEMAN_PASSWORD`, bind loopback + an authenticated tunnel / `tailscale serve`, or acknowledge with `--allow-unauthenticated-network` / `CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK=1`). This keeps Codeman "just working" for new users while making remote exposure a guided, explicit choice. Host classification lives in the new `src/web/network-auth-policy.ts` (handles `127.0.0.0/8`, `::1`, `::ffff:127.*`, bracketed IPv6).
  - A post-install security note now explains the loopback default and how to expose safely.

  **Authentication (COD-29, #107):**
  - Auth lockout now recovers gracefully: the per-IP rate-limit (`429`) check runs **after** the cookie/credential checks, so a valid session cookie or correct password is never locked out by a prior attacker's failures from the same IP (important behind a shared-IP tunnel). Wrong credentials are still counted and still hit the limit, and a `Retry-After` header is returned.

  **Downloads & content-type hardening (COD-29, #107):**
  - New session-scoped `POST /api/download` route: realpath-bounded to the session working dir, a sensitive-path blocklist (`/etc/shadow`, `~/.ssh/`, `.env`, `*credentials*`, …), `isFile()` + 50 MB cap, forced `attachment`.
  - Workspace `.svg` files are served as `application/octet-stream` + `attachment` + `nosniff` (closes a stored-XSS-via-SVG vector); `nosniff` now applies to all `file-raw` responses.

  **Dependencies & supply chain (COD-28, #106):**
  - Bumped security-sensitive deps to patched versions (`@fastify/static` 9, `fastify` 5.8, `uuid` 14, `vitest` 4.1, …) and added `overrides` for patched transitives (`picomatch`, `basic-ftp`, `fast-uri`, `flatted`); `npm audit` goes from 7 advisories to 0.
  - New `npm run check:public-assets` (`scripts/check-public-assets.mjs`): scans `src/web/public/**` for literal NUL bytes and runs `node --check` on every `.js` file, plus a Prettier pass on maintained files. Removed literal NUL placeholders from `app.js`. Added `test/dependency-security.test.ts` and `test/frontend-public-tooling.test.ts`.

  **tmux launch reliability (COD-31, #110):**
  - New tmux sessions and respawns launch from a stable `/tmp` and `cd` into the workspace inside the pane, avoiding `new-session` crashes when a FUSE/rclone-mounted workspace has a transient mount blip at launch. The `cd "<dir>" && <cmd>` form is fail-safe (the CLI never runs in `/tmp`) and the path is validated + double-quoted.

  **Test stability (COD-30, #108):**
  - Cleared leaked auth env in the Vitest setup, corrected stale route status-code / SSE-lifecycle expectations to match shipped behavior, updated the mobile keyboard accessory expectations, and measured DOMContentLoaded via browser navigation timing. Also fixed the `WebServer` title tests for the new `host` constructor arg + async `renderIndexHtml`.

  **Docs:**
  - New `docs/security-architecture.md` documenting the full model (network binding, auth pipeline, the tunnel `req.ip` caveat, file-serving hardening, supply-chain, multi-instance isolation, security headers, and recommended secure setups). CLAUDE.md updated accordingly.

## 0.8.2

### Patch Changes

- Session detach/undock, opt-in gesture-control overlay, multi-monitor spanning, new App-Settings toggles, and asset cache-busting.
  - **Session detach/undock + instance isolation (#103):** Detach a session into its own solo (popup) window from the tab strip. Adds multi-instance isolation primitives in `src/config/instance.ts` (`getDataDir()`/`dataPath()`/`DEFAULT_TMUX_SOCKET`) keyed off `CODEMAN_INSTANCE`, so a beta can run side-by-side with prod without discovering/attaching to prod's live tmux sessions or clobbering its `state.json`. `CODEMAN_INSTANCE` defaults to the production layout (`~/.codeman`, `-L codeman`, port 3000), so master installs are unaffected. Adds `scripts/run-beta.sh` (`CODEMAN_INSTANCE=beta` + `CODEMAN_PORT=5000`). The legacy `~/.claudeman` migration is now scoped to the default instance only. Hardened detach edge cases. Tests: `test/config/instance.test.ts`.
  - **Gesture-control overlay (Phase 5, opt-in via `CODEMAN_GESTURE=1`):** Camera hand-tracking overlay (self-hosted MediaPipe — wasm + model fetched at install/build via `scripts/fetch-gesture-assets.mjs` rather than committed). `CODEMAN_GESTURE=1` makes the feature _available_ (CSP widening + `/gesture/` assets + `window.__codemanGestureAvailable`); the per-user **Gesture Control (beta)** toggle (App Settings → Display → Input, default OFF) is the actual on/off and reloads the page to inject/remove the bundle. Dashboard-only (not solo popups). Labeled "(beta)" (#109).
  - **Multi-monitor button:** Header button (opt-in via App Settings → Display → Header Displays) that POSTs `/api/system/span-displays` to spawn `scripts/span-codeman.sh` — a maximized browser `--app` window sized to the union of all displays, so the gesture layer's floating panels can drag across the physical monitor seam. Tests: `test/routes/system-span-displays.test.ts`.
  - **New App-Settings toggles (#105):** Gesture control and the multi-monitor button are both opt-in (default OFF), with live show/hide on save.
  - **Asset cache-busting:** `renderIndexHtml` appends `?v=<mtime>` to every same-origin `.js`/`.css` reference; `index.html` is served `no-cache`, so a normal reload picks up edited modules/styles without a hard refresh. Tests: `test/render-index-html.test.ts`.
  - **Gesture Control toggle placement:** the toggle now lives inside the existing **Input** settings section (alongside Local Echo / CJK Input / Extended Keyboard Bar) instead of a duplicate "Input" section; only the toggle itself is hidden when `CODEMAN_GESTURE=1` is unset, leaving the rest of the section intact.
  - **Service env:** `scripts/codeman-web.service` now sets `CODEMAN_GESTURE=1` so the gesture feature is available on the local install (still gated behind the default-OFF per-user toggle).
  - **Docs:** CLAUDE.md updated for the orchestrator loop, multi-monitor/span-displays, cache-busting, gesture/multi-monitor toggles, and structural-count fixes.

## 0.8.1

### Patch Changes

- Thinking Effort now flows as a soft default the user can override in-session (PR #104, by @TeigenZhang).

  Previously Codeman carried the effort setting as the `CLAUDE_CODE_EFFORT_LEVEL` env var, which Claude Code treats as a hard override — it locked effort for the whole session and rejected in-session `/effort` switching (including switching to `ultracode`). Effort is now injected at spawn time as a CLI soft default that `/effort` can still change freely in either direction:
  - Regular levels (`low`/`medium`/`high`/`xhigh`/`max`) are passed via `claude --effort <level>` (the settings `effortLevel` key silently drops `max`, so the flag is used instead).
  - `ultracode` (xhigh effort + standing dynamic-workflow orchestration) is passed via `claude --settings '{"ultracode":true}'`, since the `--effort` flag rejects it.

  Details:
  - New `effort` field on the create-session, quick-start, and Ralph-loop request schemas; threaded through `Session._effort` to both spawn paths (tmux `buildSpawnCommand` and direct-PTY `buildInteractiveArgs`), persisted in `SessionState.effort`, and restored on reboot recovery.
  - `buildEffortCliArgs()` is the single, allowlist-validated source for both carriers (injection-safe).
  - Settings UI adds an "Ultracode (multi-agent workflows)" option to the Thinking Effort dropdown; the frontend no longer emits `CLAUDE_CODE_EFFORT_LEVEL`.
  - Legacy migration: sessions persisted with the old env var are auto-migrated into the new `effort` field, and the stale tmux env var is unset so respawned panes are no longer locked.
  - Adds `test/effort-injection.test.ts` (13 cases) covering carrier mapping, injection guards, args building, and constructor migration.

## 0.8.0

### Minor Changes

- Event-loop responsiveness fix, mobile image upload, response-viewer polish, and a mobile-UI trim.
  - **fix: avoid event-loop stalls from synchronous tmux/ps calls (#100):** The session manager ran `execSync` for tmux mouse-mode toggles, `list-panes`, and `ps`/`pgrep` resource-stat queries on the main thread. Under multi-session / many-pane load these blocking spawns froze Node's single event loop, stalling SSE broadcasts and PTY I/O (the ":3000 briefly unreachable, process never restarts" class of incident). Converted those calls to async `execAsync` and updated all callers to `await`. Added a lightweight `utils/event-loop-monitor.ts` that samples loop-delay and logs when a stall threshold is exceeded, started on web-server boot and stopped on shutdown — so future regressions leave a timestamped, quantified log line instead of vanishing silently.
  - **feat(web): mobile image upload to active session via paste dialog (#101):** The mobile keyboard-accessory paste dialog now attaches images, not just text — via a native picker (`accept=image/*` → camera / photo library / files) plus best-effort capture of images pasted into the textarea. Both paths reuse the existing `_uploadAndInsertImages()` → `POST /api/sessions/:id/paste-image` pipeline. Images are re-encoded client-side before upload (PNG→PNG to preserve transparency, everything else→JPEG, animated GIFs passed through untouched) so the bytes always match their declared extension — fixing the Android/MIUI case where a WebP/HEIF mislabeled as `image/jpeg` passed the extension allowlist but failed the server's magic-byte check. The server logs a precise diagnostic on any remaining magic-byte mismatch.
  - **feat(web): response-viewer transcript fallback + code-block rendering (#102):** A substantial response-viewer styling overhaul — proportional prose font (monospace kept for code), refined heading/code/blockquote/list styling, readable max content width, and a smoother slide-in animation; the `.rv-text` rules now also apply to `.response-viewer-body` so transcript-missing fallback content gets the same typography. Plus a `_renderMarkdown` null-safety fix (`text` → `src = text || ''`).
  - **feat(web): remove /compact button from the mobile keyboard accessory bar:** Dropped `/compact` from both the simple and extended accessory-bar layouts and the associated action handling. `/clear` retains its double-tap confirmation. Verified on a touch-emulated viewport that neither layout renders a compact action.

## 0.7.1

### Patch Changes

- **fix(respawn): auto-accept now fires on plan approvals after `Worked for X` line, and on AskUserQuestion menus**

  Two related blockers in the respawn controller's auto-accept path:
  - Modern Claude Code emits `✻ Worked for Xm Ys` immediately before a plan-approval menu. `_detectCompletionMessage()` cancelled the auto-accept timer and `canAutoAccept()` then rejected on `completionMessageTime !== null`, so plan approvals **never** auto-accepted — the 10 s completion-confirm timer instead started a respawn cycle while the menu sat unanswered.
  - The same logic in `signalElicitation()` set a hard flag that blocked auto-accept whenever Claude Code fired the `elicitation_dialog` hook, contradicting the in-UI hint ("Auto-accept presses Enter for plan approvals **and default question options**"). AskUserQuestion menus were therefore never auto-accepted either.

  Fix:
  - `_detectCompletionMessage()` no longer cancels the auto-accept timer; the auto-accept pre-filter is now the authoritative "is there a numbered selection menu?" gate.
  - `canAutoAccept()` and the AI-plan-check callback both accept `'watching'` AND `'confirming_idle'` states (covers the single-PTY-burst case where `Worked for` and the menu arrive together — `_detectCompletionMessage` returns early before the substantial-output check can demote state back to watching). `sendAutoAcceptEnter()` self-transitions back to `'watching'` before sending Enter.
  - `signalElicitation()` is now an affirmative hint that primes the auto-accept timer instead of blocking. Still gated on `config.autoAcceptPrompts` AND state ∈ {`watching`, `confirming_idle`} — never fires Enter when respawn is off or auto-accept is disabled.
  - AI plan-check prompt broadened to recognize AskUserQuestion / elicitation menus as valid for auto-accept (the verdict name `PLAN_MODE` is preserved for compatibility but now means "auto-accept this selection menu").
  - Removed the now-unused `elicitationDetected` field and its assignments.

  Two new regression tests cover both the separate-PTY-chunk and single-PTY-chunk cases; the previously misleading "should NOT send Enter when completion message was detected" test was renamed and re-scoped to clarify it tests the **no-menu** path (which still correctly rejects via the pre-filter).

  **docs(web): correct `sendPendingCtrlL` comment** — removed the stale "called by foo/bar" note from the dead-call-graph helper after #99.

## 0.7.0

### Minor Changes

- Response viewer & terminal-stability improvements, plus test/error-handling hardening.
  - **Copy button on code blocks (#98):** Every fenced code block in the response viewer now has a one-click copy button pinned to its top-right, outside the `<pre>` scroll container so it stays put during horizontal scroll. ASCII diagrams keep their line-wrap toggle alongside it. Copy prefers the async Clipboard API and falls back to a hidden-textarea + `execCommand` path, so it works over plain HTTP (tunnel) too, with a brief ✓/✕ feedback state.
  - **Fix: stop auto-sending Ctrl+L from session-selection paths (#99):** A fast page refresh or SSE reconnect could fire two programmatic Ctrl+L (`\x0c`) sends within Claude Code 2.x's "clear conversation" confirmation window, silently wiping the active conversation. Removed the automatic Ctrl+L sends from `selectSession()`, `restoreTerminalSize()`, and the dead `sendPendingCtrlL()` path; redraws now rely on resize/SIGWINCH. User-initiated Ctrl+L still works. Trade-off: an occasional transient stale Ink frame right after refresh that self-heals on the next keypress — far preferable to silent data loss.
  - **Test & error-handling hardening (#97):** Repaired route-test harness error rendering via a dedicated `route-error-handler.ts`, and stopped the AI idle/plan checkers from spawning real processes during tests.

## 0.6.12

### Patch Changes

- Fix new-session crash after a tmux upgrade and isolate Codeman sessions on a dedicated tmux socket.
  - **Pane file-descriptor limit**: raise `ulimit -Sn` before launching the CLI (in both the spawn and respawn paths) so the newer tmux + macOS launchd combination — which hands panes a low soft `nofile` limit (256) that recent Claude Code refuses to start under — no longer kills every freshly spawned session on startup.
  - **Single-socket isolation**: all Codeman-owned tmux sessions now live on a dedicated socket (`tmux -L codeman`, overridable via `CODEMAN_TMUX_SOCKET`), fully separated from the user's default tmux server. The socket name is validated and shell-escaped at every call site.
  - **Drop the drift-prone per-session `tmuxSocket` field**: session reconciliation collapses to a single `list-panes` query against the one socket, eliminating live sessions being wrongly marked dead ("session not found") and duplicate "Restored:" tabs. Stale per-session socket tags and duplicate records are cleaned from disk on load (dedup by `muxName`, keeping the real entry over `restored-` placeholders).
  - **Route remaining bare-`tmux` call sites through the socket**: the window-size query on re-attach (previously fell back to 120×40 and lost scrollback) and the send-key route (Shift+Enter / Ctrl+Enter newline).
  - **SSH chooser scripts** (`tmux-manager.sh`, `tmux-chooser.sh`) route every tmux call through the dedicated socket.

## 0.6.11

### Patch Changes

- Resume Conversation: fixes and folder drill-down.
  - **fix(history)**: `decodeProjectKey()` now uses longest-join-first backtracking with on-disk validation, so sibling directories sharing a prefix (e.g. `diary/` vs `diary-app/`) resolve to the correct path. Previously the greedy shortest-match decoder picked the shorter name and bailed, surfacing `$HOME` in the Resume Conversation list and resuming into the wrong folder. Greedy decode is kept as a fallback so history for deleted projects still resolves. (#92)
  - **fix(tabs)**: Drop the client-side resurrection of ended-session tabs. The old code cached open tabs in `localStorage` and rebuilt them as grayed-out stubs whenever the server no longer knew them, which left phantom tabs after closing a session on another device. The server is now the single source of truth; legacy `localStorage` keys are purged on init. Net -44 / +6 lines. (#93)
  - **feat(history)**: New "View all in this folder" drill-down on Resume Conversation. `GET /api/history/sessions` accepts `projectKey` (validated against `^[A-Za-z0-9_-]+$` before any filesystem access), `offset`, and `limit`; single-folder mode bypasses the 50-cap and returns `{ sessions, total }`. Frontend adds a modal listing 20 sessions per page with a "Show more" pagination button. Modal items omit their own "View all" button to prevent recursive entry points. (#94)

## 0.6.10

### Patch Changes

- ## Security: paste-image endpoint hardening (#90)

  Addresses seven findings from the dismissed review of #84. Most exposed in tunneled deployments where `CODEMAN_PASSWORD` is set but the server is reachable beyond localhost.
  - **CSRF protection** on `POST /api/sessions/:id/paste-image`. Requires `Origin`/`Referer` to match `req.host`; non-browser clients (no `Origin` and no `Referer`) must send `X-Codeman-CSRF`. Defeats cross-origin `<form enctype="multipart/form-data">` submits that would otherwise plant arbitrary bytes into the victim's `.claude-images/` while their session cookie is live.
  - **Magic-byte validation** on uploaded images. Sniffs the first 12 bytes against PNG/JPEG/GIF/WebP/BMP signatures and rejects 415 on mismatch. Polyglot HTML-or-SVG-with-image-MIME no longer round-trips through the endpoint.
  - **Symlink-safe writes** on `.claude-images/`. `lstat` before the write, non-recursive `mkdir`, `O_EXCL|O_NOFOLLOW` on file open. A `node_modules` postinstall (or the agent itself) planting `.claude-images -> ~/.ssh/` no longer redirects pastes outside `workingDir`.
  - **Multipart parser swap** to `@fastify/multipart` with `limits: { fileSize: 10MB, files: 1, fields: 4 }`. Replaces a hand-rolled boundary scanner that matched the literal boundary anywhere in the body, hard-coded `\r\n` (silently corrupting LF-only clients), and had no part-count cap.
  - **Rate limit + GC**: token-bucket (30/min per IP+session) and hourly GC of `paste-*` files older than 7 days from each live session's `.claude-images/`. New `paste-image-gc.ts` started/stopped from `WebServer.start/stop`.
  - **Collision-free filenames**: `paste-${Date.now()}-${randomBytes(4)}${ext}`. Two tabs pasting in the same millisecond no longer silently last-write-wins.
  - **Bracketed-paste preservation**: text-only paste in `image-input.js` now goes through `terminal.paste(text)` instead of `sendInput(text)`, so xterm preserves `CSI 200~ ... CSI 201~` markers — Claude Code uses them as part of its prompt-injection defenses.

  ## Fix: duplicate multipart parser conflict

  Removed a duplicate multipart content-type parser left behind after the swap above. The duplicate registration conflicted with `@fastify/multipart`'s own parser; uploads now flow through the plugin exclusively.

  ## WebGL renderer auto-fallback hardening (#91)

  Follow-ups on the longtask auto-fallback shipped in #83.
  - `PerformanceObserver` is now disconnected on `onContextLoss` as well as on the trip path. Previously the observer outlived its disposed addon after a context loss, holding a closure reference over every longtask the page emitted.
  - Thresholds (`200ms / 3 longtasks / 30s window / 5s grace / 7d sticky-disable`) are hoisted to `WEBGL_FALLBACK` in `constants.js`. No more inline literals.
  - New `evaluateWebGLLongTaskTrip()` pure helper splits the rolling-window arithmetic from the `PerformanceObserver` callback so the trip math is unit-testable. New `test/webgl-fallback.test.ts` (9 tests, port 3166): trip inside window, no-trip when spread, sub-threshold filtering, stale-entry pruning, cumulative counting across batches, observer-dispose idempotency.

  ## CI: server boot smoke test

  GitHub Actions now boots the server as a final step after typecheck/lint/format. Catches production-only ESM/CJS regressions that `tsx` masks in dev.

  ## Docs

  `CLAUDE.md` frontend-module table updated to include `image-input.js` (overlooked when #84 landed).

## 0.6.9

### Patch Changes

- Terminal renderer hardening, SSE bandwidth cut, image paste, and a security tightening on the new live filter:
  - **Multi-primitive yield for write pacing** (#85): replaces six raw `requestAnimationFrame` callsites in the xterm.js write pipeline with a yielding helper that races `requestAnimationFrame`, `setTimeout(50)`, and a tick Worker. Keeps the terminal responsive when the tab is backgrounded or occluded — Chrome's intensive-throttling no longer stalls long writes.
  - **WebGL longtask auto-fallback** (#83): a `PerformanceObserver` watches for ≥200ms WebGL frames; three within a 30s window disposes the WebGL addon and falls back to the canvas renderer. Decision is persisted in localStorage for 7 days, and `?webgl=force` clears it.
  - **Per-client live SSE subscription filter** (#86): each connected client gets a stable UUID and can narrow its terminal stream to one session via `POST /api/events/subscribe` — no EventSource reconnect on tab switches. Cuts SSE bandwidth roughly N× when N sessions are open. Lifecycle/metadata events (`session:*`, `case:*`, `ralph:*`, `hook:*`) now broadcast to every client so sidebars stay in sync.
  - **Image paste and drag-and-drop into the terminal** (#84): `Ctrl+V` and dropped images upload to `POST /api/sessions/:id/paste-image`, save under `${workingDir}/.claude-images/paste-${ts}.${ext}` and type the path into the terminal. Hard 10MB cap, server-generated filename (no traversal), `.svg` deliberately excluded from the allowlist to avoid a same-origin XSS path through `file-raw`.
  - **SSE clientId validation**: the per-client identifier introduced in #86 is now constrained to `[A-Za-z0-9_-]{8,64}` at both ingress points. Without this, an authenticated attacker could send another tab's clientId to silently evict it from broadcasts, mutate any clientId's session filter to blackhole the victim's terminal stream, or grow `sseClientsById` unboundedly via long IDs. The subscribe payload is also capped at 64 session entries of ≤128 chars each.

## 0.6.8

### Patch Changes

- Finish the hostname-aware notification plumbing started in 0.6.7 and lock down the recent UI/runtime fixes with regression tests.
  - Browser Notification API (OS-level desktop pop-ups, layer 3 of the 5-layer notification system) now uses `${originalTitle}: ${title}` instead of the hardcoded `Codeman:` literal — so multi-host users running Codeman on laptop / dev box / NAS see `codeman:<host>: <event>` consistently across tab title, tab-flash, Web Push, and OS notifications.
  - Inline session rename hardened against three corner cases: IME composition commits (Chinese pinyin Enter no longer ships half-composed text as the session name), mid-rename SSE deletion (orphaned `<input>` no longer 404s on blur), and double-fire on stuck settle-once flag (closure-local `settled` boolean replaces the boolean instance flag).
  - Test coverage backfilled for two prior shipped fixes:
    - `<title>codeman:<host></title>` server-side templating (#82): 8 tests covering default `os.hostname()`, `--title-hostname` override, HTML-escape against `<script>`-style breakout, ampersand non-double-encoding, and template-tail byte-identical invariance.
    - tmux size-query helper (#80): 15 tests covering the browser-resize-between-attaches happy path, the query-then-die race, zero/negative/empty/non-numeric output fallbacks, and argv-form/timeout assertions that lock down the no-shell-interpolation guarantee. Inline 14-line query block extracted into a named `queryTmuxWindowSize()` export in `session.ts` so the test surface is a pure function.
  - Regression coverage added for `stripInkRedrawBloat` route helper.
  - CLAUDE.md and README.md updated to document dual-CLI env-prefix discipline (`CLAUDE_CODE_*` vs `OPENCODE_*`), the `xterm-zerolag-input` published-package side-effect of overlay edits, and the unified hostname prefix across tab title / tab-flash / OS notifications.

## 0.6.7

### Patch Changes

- - **fix(client): preserve inline rename input across tab re-renders** (#81) — Right-click → rename on a session tab no longer loses keystrokes when SSE traffic from sibling sessions triggers a tab re-render. Adds an `_inlineRenameActive` guard at the top of `renderSessionTabs()` and `_fullRenameSessionTabs()` so the in-progress input isn't destroyed mid-typing. Also fixes a latent double-fire of `finishRename` (blur + Enter could both invoke it). Drive-by: safer DOM child clearing in place of `innerHTML = ''`.
  - **feat: hostname-aware window title** (#82) — The browser tab title is now `codeman:<hostname>` instead of the bare `Codeman` literal, so users running Codeman on multiple hosts (laptop, dev box, NAS) can tell at a glance which tab points at which backend. New `--title-hostname <name>` CLI flag overrides the detected `os.hostname()` when it's noisy or you want a cosmetic name. The title is templated into the served HTML on first byte (with narrow HTML escaping), so it's correct from the first paint and works without JavaScript. Title-flash logic now respects the per-host title.
  - **perf: larger terminal tail on tab switch** — `TERMINAL_TAIL_SIZE` raised from 128KB to 1MB. When switching back to a busy session tab you now get ~8× more scrollback restored immediately.
  - **fix: preserve response text in Ink redraw stripping** — `stripInkRedrawBloat()` rewritten from a first-VPA approach to cluster-based detection. The previous algorithm assumed all VPA escapes after the first one belonged to a single redraw region and discarded everything in between, which silently lost 100KB+ of legitimate Claude response text once a render had occurred. The new approach groups VPAs into clusters separated by ≥8KB gaps and only collapses clusters spanning ≥32KB, so streamed response content between redraw bursts is preserved.
  - **docs**: `CLAUDE.md` Additional Commands gains the `--title-hostname` row; `README.md` gets a "Hostname-Aware Window Title" subsection under Multi-Session Dashboard.

## 0.6.6

### Patch Changes

- **Terminal scrollback significantly increased** — both the xterm.js viewport and the tmux backing buffer were bottlenecking how far back you could scroll. Three changes:
  - `DEFAULT_SCROLLBACK` raised from 20000 → 50000 lines (xterm.js, main terminal). The previous bump from 5000 only helped users with empty localStorage; existing users were stuck on whatever value they first picked up. The loader now treats `DEFAULT_SCROLLBACK` as a floor — if your stored value is below the new minimum, you're raised to it automatically.
  - Subagent / teammate terminals (`panels-ui.js`) were stuck at 5000; now use the same `DEFAULT_SCROLLBACK` constant (50000).
  - New tmux sessions now run with `history-limit 50000` (tmux defaults to 2000). This matters for hard-reload / re-attach — without it, only the last ~2000 lines survive the round-trip back into a fresh xterm.

  **Tmux flicker on session re-attach fixed (PR #80 by @aakhter)**: the PTY now queries the existing tmux window size via `tmux display -p` before spawning, instead of hardcoding 120x40. Previously, every re-attach forced tmux to resize down to 120x40, causing a visible flicker and one frame of scrollback loss. The `-x 120 -y 40` flag was also dropped from `tmux new-session` so the initial size matches the first attaching client. Uses `execFileSync` (not shell) for safety and falls back to 120x40 on any error.

  **Docs**: CLAUDE.md now documents two recurring foot-guns — the `xterm-zerolag-input` overlay code is duplicated between `packages/xterm-zerolag-input/src/` and inline inside `src/web/public/app.js`, so any overlay change must touch both; and the COM workflow explicitly includes a post-push `gh run watch` step to confirm CI before considering the release done.

## 0.6.5

### Patch Changes

- **Mobile fix**
  - Android virtual keyboard: space character was silently dropped on touch devices using GBoard / SwiftKey / similar IMEs. Root cause: the input-event handler in `terminal-ui.js` treated any whitespace-only textarea value as proof that xterm had already processed the input. A lone space (`' '.trim() === ''`) tripped this guard, so the space was consumed but never forwarded. Now skips only when the textarea is truly empty (or whitespace from a non-space key). Reported and diagnosed by @coolk8 in #79.

  **Docs**
  - `CLAUDE.md`: added Zod `.optional()`-vs-`null` gotcha (recurring trap from 0.6.3 / 0.6.4 incidents) and a more visible warning against running bare `npm test` (kills the host tmux session).
  - `docs/local-echo-overlay-plan.md`: marked SHIPPED, corrected xterm version reference (v5.3.0 → `@xterm/xterm` ^6.0.0).

## 0.6.4

### Patch Changes

- Fix "Failed to enable respawn: Invalid request body" error when selecting infinity duration (∞) in the respawn modal. Frontend was sending `durationMinutes: null`, which Zod's `.optional()` schema rejected (it accepts `undefined` only). The body now omits the field when no duration is selected.

## 0.6.3

### Patch Changes

- **Fix**
  - Allowlist `opusContext1mEnabled` in `SettingsUpdateSchema`. Without this entry, the strict schema rejected `PUT /api/settings {"opusContext1mEnabled":...}` with `INVALID_INPUT`, so the toggle's value never persisted across reloads. The frontend was already reading and writing this key (`settings-ui.js:336/1137`, `session-ui.js:340`), so saves were silently failing — users never noticed because the load path falls back to `false` on missing keys, hiding the bug. (#78)

## 0.6.2

### Patch Changes

- **Mobile UX**
  - Resume Conversation list (welcome page) reworked for narrow screens: 2-line title clamp so more of the first prompt is visible; case-aware subtitle that renders `#caseName` (or `#caseName/sub`) when `workingDir` matches a known case, otherwise falls back to the directory basename; inline `⋯` toggle that expands a detail panel with full prompt, full path, timestamp, size, and short session id; `/Users/<user>/` now collapses to `~/` alongside `/home/<user>/`. (#77)
  - Response viewer: ASCII diagram wrap toggle, dedicated mobile code-block layout, and chrome-stripping fallback when the model wraps its reply in extra markup. (#75)
  - Mobile keyboard accessory bar no longer triggers vertical scroll. (#72)

  **Sessions & settings**
  - New `thinkingEffort` setting on session creation, with `xhigh` option and `/effort max` mobile shortcut. (#73)
  - `thinkingEffort` is now allowlisted in `SettingsUpdateSchema` so it round-trips through PATCH /api/settings.
  - `envOverrides` (`CLAUDE_CODE_*` / `OPENCODE_*`) are now passed to Claude via tmux env exports at spawn time instead of being written to `<case>/.claude/settings.local.json`. Eliminates UI/disk drift; the value lives on `Session._envOverrides`, is exported by `tmux-manager.buildEnvExports()`, and is persisted in `SessionState.envOverrides`. (#74)

  **Fixes**
  - Eye icon (active-session indicator) now follows `/clear` to the new Claude conversation instead of getting stuck on the previous transcript. (#76)
  - `tmux-manager.reconcileSessions` now uses `|` as the field separator, fixing parsing when session names contain other delimiters. (#71)

  **Docs**
  - CLAUDE.md: added `npm run knip` to the dead-code sweep table and a `Common Gotchas` entry documenting the `envOverrides` → tmux export flow.

## 0.6.1

### Patch Changes

- Internal cleanup and release hygiene:
  - **Dead-code sweep via knip**: added `knip.json` for dead-code detection and ran a full sweep — removed unused test files, unused scripts, and narrowed internal module exports to the minimum surface area actually consumed.
  - **Lockfile drift prevention**: `version-packages` now runs `npm install --package-lock-only` and verifies the lockfile is in sync via `scripts/check-lockfile-sync.mjs`; CI runs the same check on every push/PR so version drift fails the build instead of reaching production. Resolves the `package-lock.json` / `package.json` version mismatch that shipped in 0.6.0.
  - **Docs tightening**: archived 22 completed plan docs from `docs/`, corrected file/handler counts in `CLAUDE.md`, documented the lockfile step in the COM workflow, and removed footer redundancy.

## 0.6.0

### Minor Changes

- Community contributions from @aakhter:
  - **feat (#66): Tab reorder shortcuts** — `Ctrl+Shift+{` and `Ctrl+Shift+}` move the active session tab left/right, matching WezTerm convention. Order persists across reloads via `saveSessionOrder()`.
  - **feat (#67): Active tab visibility + Alt+N badges** — active tab now has a bright green border with color-matched glow, and the first 9 tabs display number badges hinting at the `Alt+N` switch shortcut. Badges update on reorder/rerender.
  - **feat (#68): Clipboard API** — new `POST /api/clipboard` accepting `{text}` broadcasts a `clipboard:write` SSE event; connected browsers attempt `navigator.clipboard.writeText()` with a manual-copy modal fallback when the page isn't focused. Auth-protected via the standard middleware. Useful for pushing snippets from remote sessions to the user's local clipboard.
  - **fix (#65): Android Shift+key double character** — pressing `Shift+A` on attached Android keyboards no longer produces "AA". Tracks xterm-handled keydown timestamps and skips the orphaned-input listener for 50ms after a real keydown, while still catching Gboard symbol-keyboard inputs (keyCode 229).

## 0.5.13

### Patch Changes

- Fix "Case path not found" error in Quick Start when `~/codeman-cases/` does not exist (issue #64). Two bugs in `session-ui.js`:
  - `runClaude()` auto-create read `createCaseData.case`, but `POST /api/cases` returns `{ success, data: { case } }` — corrected to `createCaseData.data.case`.
  - `runShell()` had no auto-create logic and would immediately throw on a missing case directory — now mirrors `runClaude()`'s create-on-demand flow.

## 0.5.12

### Patch Changes

- Fix quick-start to resolve linked cases before codeman-cases fallback. `/api/quick-start` was always resolving `caseName` against `CASES_DIR`, ignoring entries in `~/.codeman/linked-cases.json`. Sessions started via quick-start now correctly honour linked external project directories, consistent with regular case routes.

## 0.5.11

### Patch Changes

- Community contributions and security hardening:
  - Mobile response viewer: native-scroll panel for reading full Claude responses with markdown rendering via marked.js (PR #62)
  - PWA support: service worker caching, web app manifest, and Android home screen install (PR #59)
  - Named Cloudflare tunnel support (PR #58)
  - Markdown rendering for response viewer with HTML sanitization (XSS prevention) — strips dangerous elements, event handlers, and javascript: URIs
  - Service worker switched from stale-while-revalidate to network-first caching so deploys take effect immediately
  - Content-Disposition filename sanitization to prevent header injection in file downloads
  - Expose session.muxName public getter, replace unsafe `as any` cast in session-routes
  - Static import for execFile in session-routes
  - Keyboard shortcut updates: Alt+1-9 tab switching, Shift+Enter newline
  - Repo restructure for cleaner GitHub landing page
  - Mobile logo, expandable history, session resume fixes

## 0.5.10

### Patch Changes

- fix: allow bracket characters in model validation regex so models like opus[1m] (1M context window) are accepted instead of silently dropped. Quote the model flag value in tmux spawn commands to prevent bash glob expansion of bracket patterns.

  docs: update macOS launchd instructions to use `launchctl bootstrap` instead of deprecated `load`. Clean up README install and service sections.

## 0.5.9

### Patch Changes

- Mobile keyboard accessory bar: add configurable "Extended Keyboard Bar" setting (Settings > Display > Input) that toggles between simple mode (up/down arrows, /init, /clear, /compact, paste, dismiss) and extended mode (adds left/right arrows, Tab, Shift+Tab, Ctrl+O, Alt+Enter, Esc). Default is simple mode. Setting is device-specific (not synced to server).

  Restyle dismiss button: muted steel-blue tone, fills remaining bar space via flex, larger tap target. Arrow buttons now blue.

  Fix paste overlay visibility on mobile: dialog repositioned to top of screen (15vh from top) so the virtual keyboard doesn't cover it. Textarea enlarged for better usability.

  (Also includes all v0.5.8 changes: case reorder/delete, XSS sanitization, auto-attach PTY on restart, mobile keyboard buttons, macOS installer fixes, terminal flicker fix, state store collision fix.)

## 0.5.8

### Patch Changes

- Case management: add Manage tab with reorder (up/down arrows) and delete for cases; linked cases are unlinked (folder preserved), CASES_DIR cases are permanently deleted. New endpoints: DELETE /api/cases/:name, PUT /api/cases/order. SSE events: case:deleted, case:order-changed.

  Security: sanitize case names from filesystem with /^[a-zA-Z0-9_-]+$/ regex before returning from GET /api/cases to prevent XSS via maliciously-named directories reaching frontend inline onclick handlers.

  Auto-attach PTY: server now calls startInteractive() for recovered tmux sessions during startup so all sessions resume capturing output immediately after deploy, instead of waiting for client selection. Frontend auto-attach condition relaxed from (pid===null && status==='idle') to (pid===null && !\_ended).

  Mobile keyboard accessory: add Shift+Tab, Tab, Esc, Alt+Enter, Left/Right arrow, and Ctrl+O buttons.

  Terminal: fix flicker regression by moving viewport clear inside dimension guard.

  State store: fix temp file collisions on concurrent writes.

  macOS: fix installer failures when piped via curl | bash, add HTML cache support, launchd service template, and trust dialog handling.

  Housekeeping: remove accidentally committed dist/state-store.js build artifact.

## 0.5.7

### Patch Changes

- feat: support "Default (CLI default)" option for model selection. Adds a new empty-value option to the model dropdown that defers to the CLI's own default model instead of forcing a specific model. Ensures empty defaultModel values are treated as undefined when passed to session creation and Ralph loop start, preventing empty strings from being sent as model flags.

## 0.5.6

### Patch Changes

- fix: default new sessions to opus[1m] (1M context window) instead of plain opus (200k context)

## 0.5.5

### Patch Changes

- Add 1M Opus context quick setting — per-case and global toggle that writes `model: "opus[1m]"` to `.claude/settings.local.json` when creating new sessions. Fix mobile layout: banners (respawn, timer, orchestrator) between header and main content now visible by switching from margin-top on `.main` to padding-top on `.app`. Add tablet-optimized respawn banner styles and mobile phone banner refinements.

## 0.5.4

### Patch Changes

- Fix terminal flicker regression — re-add server-side DEC 2026 synchronized output wrapping around batched terminal data. Ink spinner frames (cursor-up + redraw cycles) do not emit their own DEC 2026 markers, so without the server wrapper each partial cursor update rendered individually causing visible flicker. Also: extract SSE stream management, session listener wiring, and respawn event wiring from server.ts into dedicated modules; deduplicate error message extraction across 7 files with shared getErrorMessage() helper; update SSE event count in CLAUDE.md (106 → 117).

## 0.5.3

### Patch Changes

- Readability refactor across 12 core files, extracting ~35 helper methods to reduce duplication:
  - state-store: extract serializeState(), split assembleStateJson() into focused sub-methods
  - session: extract \_resetBuffers() (3x dedup), \_clearAllTimers() (10 timer cleanups), \_handleJsonMessage()
  - ralph-tracker: extract completeAllTodos() (4x dedup), emitValidationWarning(), named similarity constants
  - subagent-watcher: extract markSubagentAsCompleted(), extractFirstTextContent(), emitToolResult(), findOldestInactiveAgent()
  - respawn-controller: extract recoveryResetToWatching(), canAutoAccept(), formatRemainingSeconds(), validatePositiveTimeout()
  - tmux-manager: replace 15 path.includes() with UNSAFE_PATH_CHARS regex, extract buildEnvExports/buildPathExport/\_configureOpenCode helpers
  - session-auto-ops: extract executeWhenIdle() shared retry helper, convert to options object, add validateThreshold()
  - app.js: add \_clearTimer() (11 call sites), \_isStaleSelect(), keyboard shortcut lookup table, \_cleanupPreviousSession(), \_resetAllAppState()
  - route-helpers: add readJsonConfig() (5 inline patterns replaced), validateSessionFilePath() (2 duplicated blocks replaced)

## 0.5.2

### Patch Changes

- Make buffer size limits configurable via CODEMAN\_\* environment variables (MAX_TERMINAL_BUFFER, TRIM_TERMINAL_TO, MAX_TEXT_OUTPUT, TRIM_TEXT_TO, MAX_MESSAGES), falling back to existing defaults. Allows users with fewer sessions or more RAM to tune buffer sizes without patching source.

  Fix duplicate terminal output on tab switch to busy sessions by clearing the terminal before writing the new buffer.

  Fix stale Ink CUP frames after tab switch by sending Ctrl+L to force a clean redraw.

  Fix mobile CJK input handling: resolve textarea positioning, terminal flicker during composition, and layout overflow on small screens. Improve CJK composition lifecycle with better event handling and fallback flush timers.

## 0.5.1

### Patch Changes

- refactor: codebase cleanup — extract route helpers, eliminate boilerplate, optimize hot paths
  - Add `parseBody()` helper to route-helpers.ts: validates request body against Zod schema with structured 400 error on failure, replacing 37 identical safeParse + error-check blocks across 10 route files
  - Add `persistAndBroadcastSession()` helper: combines persist + SessionUpdated broadcast into one call, replacing 5 repeated 2-line pairs
  - Migrate session-routes.ts to use `findSessionOrFail()` consistently (17 inline session lookups replaced) and `parseBody()` (12 patterns)
  - Migrate ralph-routes.ts to use `findSessionOrFail()` (9 lookups) and `parseBody()` (4 patterns)
  - Migrate 8 remaining route files to use `parseBody()` (21 patterns total)
  - Fix O(n log n) eviction in bash-tool-parser.ts: replace `Array.from().sort()[0]` with O(n) min-scan for oldest active tool
  - Extract `_debouncedCall()` utility in frontend: replaces 4 manual debounce patterns (7 lines each → 1 line) in app.js, panels-ui.js, ralph-panel.js
  - Net reduction: 208 lines removed across 16 files

## 0.5.0

### Minor Changes

- Visual redesign with glass morphism, refined colors, and polished UI. Optimize history endpoint with buffer reuse and line iterator. Fix Ink frame search window (4KB→64KB) to prevent partial frames. Fix stale terminal data on tab switch via chunkedTerminalWrite cancellation. Improve history prompt extraction with expanded command filtering and tail scan fallback. Align case select group height to match dropdown. Fix no-control-regex lint error for ANSI strip pattern. Add browser-testing-guide to CLAUDE.md references.

## 0.4.7

### Patch Changes

- feat: improve session navigability in history and monitor panel (closes #45)
  - History items now show the first user prompt as the title with the project path as a subtitle, making it much easier to distinguish sessions from the same project
  - The `/api/history/sessions` endpoint extracts the first user message from each transcript JSONL, stripping system-injected XML tags and command artifacts, truncating to 120 chars
  - Monitor panel session rows are now clickable — clicking navigates directly to that session's tab via `selectSession()`; Kill button retains independent behavior via `stopPropagation()`
  - Updated CLAUDE.md architecture tables to reflect Orchestrator Loop additions (14 route modules, 15 type files, orchestrator domain files, orchestrator-panel.js frontend module)
  - fix: stop subagent monitor windows from auto-opening on discovery
  - feat: add Orchestrator Loop with phased plan execution, live progress during plan generation, and toolbar button (hidden until fully tested)
  - fix: patch 3 production bugs found during deep audit
  - fix: restore mobile terminal scrollback using JS scrollLines() instead of broken native scroll

## 0.4.6

### Patch Changes

- Fix mobile keyboard scroll and layout issues:
  - Prevent iOS Safari from scrolling the page when typing with the keyboard open (position:fixed on .app + window.scroll reset)
  - Eliminate dead space between terminal and keyboard accessory bar by removing redundant CSS padding, tightening JS padding constant, and adding row quantization gap compensation
  - Fix toolbar overlapping terminal content when keyboard is hidden by adding proper padding-bottom to .main, including iOS Safari bottom bar offset
  - Strip Ink spinner bloat from terminal buffer before tailing
  - Fix resolveCasePath priority order and suppress JSON parse warnings

## 0.4.5

### Patch Changes

- Fix mobile keyboard toolbar positioning on iOS Safari: toolbar (Run/Stop/Run Shell) was hidden behind the accessory bar when virtual keyboard was active due to overlapping CSS positions. Remove the aggressive safety check in `updateLayoutForKeyboard()` that incorrectly dismissed keyboard state when iOS scrolled the visual viewport during typing. Add Safari-bar CSS offset to accessory bar so it properly stacks above the toolbar. Remove the double-counted Safari-bar offset when keyboard is visible since the JS transform already covers the full distance.

## 0.4.4

### Patch Changes

- fix: mobile keyboard hides terminal content on iPhone

  Fixed a bug where opening the virtual keyboard on iPhone left zero visible terminal space. Two independent mechanisms were both accounting for the keyboard height: `MobileDetection.updateAppHeight()` shrunk `--app-height` to the visual viewport height, while `KeyboardHandler.updateLayoutForKeyboard()` added a large `paddingBottom`. These double-counted, leaving negative space for the terminal (user saw accessory bar + toolbar but no terminal content).

  Fix: `updateAppHeight()` now skips when the keyboard is visible, and `handleViewportResize()` restores `--app-height` to the pre-keyboard value on first detection (since MobileDetection's listener fires before KeyboardHandler's). On keyboard close, `--app-height` is re-synced to the current visual viewport.

## 0.4.3

### Patch Changes

- Refactor case routes: extract readLinkedCases() and resolveCasePath() helpers to eliminate 6x duplicated linked-cases.json path construction and 5x duplicated file read/parse logic. Replace O(n) .some() duplicate check with O(1) Set.has() in case listing. Un-export unused isError() type guard. Standardize reply.status() to reply.code() in system routes. Update CLAUDE.md frontend module listing and SSE event count.

## 0.4.2

### Patch Changes

- Extract monolithic app.js (~12.5K lines) into 6 focused domain modules that extend CodemanApp.prototype via Object.assign: terminal-ui.js (terminal setup, rendering pipeline, controls), respawn-ui.js (respawn banner, countdown, presets, run summary), ralph-panel.js (Ralph state panel, fix_plan, plan versioning), settings-ui.js (app settings, visibility, web push, tunnel/QR, help), panels-ui.js (subagent panel, teams, insights, file browser, log viewer), session-ui.js (quick start, session options, case settings). Fix critical deferred script init ordering bug: wrap CodemanApp instantiation in DOMContentLoaded so all defer'd mixin modules execute their Object.assign before the constructor runs. Guard missing cleanupWizardDragging() call in subagent-windows.js. Update build.mjs to minify/hash all new modules.

## 0.4.1

### Patch Changes

- Performance optimizations: V8 compile cache for 10-20% faster cold starts, lazy-load WebGL addon (244KB saved on mobile), preload hints for critical scripts, batch tmux reconciliation (N subprocess calls → 1). Also: WebSocket session lifecycle fixes, CJK IME input support, CI upgrade to Node 24/actions v6, install.sh fork support, and CLAUDE.md/README documentation refresh.

## 0.4.0

### Minor Changes

- Add CJK IME input textarea for xterm.js terminal (env toggle INPUT_CJK_FORM=ON). Always-visible textarea below terminal handles native browser IME composition, forwarding completed text to PTY on Enter. Supports arrow keys, Ctrl combos, backspace passthrough, and Escape to clear.

  Add fork installation support to install.sh with CODEMAN_REPO_URL and CODEMAN_BRANCH env vars, allowing custom repository and branch for git clone/update operations. README updated with fork installation instructions.

  Fix WebSocket session lifecycle: close WS connections when session exits (prevents orphaned listeners and stale writes to dead PTY), add readyState guard in onTerminal to stop buffering after socket closes, simplify heartbeat by removing redundant alive flag.

  Add WebSocket reconnection with exponential backoff (1s-10s) on unexpected close, skipping server rejection codes (4004/4008/4009). Falls back gracefully to SSE+POST during reconnection.

  Clear CJK textarea on session switch to prevent sending stale text to wrong session.

## 0.3.12

### Patch Changes

- Add WebSocket terminal I/O with server-side DEC 2026 synchronized update markers. Replaces per-keystroke HTTP POST + SSE terminal output with a single bidirectional WebSocket connection for dramatically lower input latency. Server-side 8ms micro-batching with 16KB flush threshold groups rapid PTY events into single WS frames wrapped in DEC 2026 markers for flicker-free atomic rendering. Includes 30s ping/pong heartbeat with 10s timeout for stale connection detection through tunnels. Existing SSE + HTTP POST paths remain fully functional as transparent fallback. Resize messages validated to match HTTP route bounds (cols 1-500, rows 1-200, integers only). 16 automated route tests added for WS endpoint. Also patches 5 dependency vulnerabilities (basic-ftp, fastify, minimatch, serialize-javascript).

## 0.3.11

### Patch Changes

- ### Session Resume & History
  - Add `resumeSessionId` support for conversation resume after reboot
  - Add history session resume UI and API with route shell sessions routing fix
  - Improve session resume reliability and persist user settings across refresh
  - Correct `claudeSessionId` for resumed sessions

  ### Terminal & Frontend
  - Upgrade xterm.js 5.3 → 6.0 with native DEC 2026 synchronized output
  - Increase terminal scrollback from 5,000 to 20,000 lines
  - Reduce default font size and persist tab state across refresh
  - Resolve terminal resize scrollback ghost renders
  - Hide subagent monitor panel by default

  ### Installer
  - Auto-detect existing install and run update instead of fresh install
  - Auto-restart codeman-web service after update if running
  - Show restart command when codeman-web is not a systemd service
  - Fix one-liner restart command for background processes

  ### Codebase Quality
  - Remove dead code, consolidate imports, extract constants
  - Repair 15 pre-existing subagent-watcher test failures
  - Clean up DEC sync dead code

## 0.3.10

### Patch Changes

- - feat: upgrade xterm.js from 5.3 to 6.0 with native DEC 2026 synchronized output support
  - feat: add history session resume UI and API — resume Claude conversations after reboot
  - feat: add resumeSessionId support for conversation resume across session restarts
  - feat: persist active tabs across page refresh
  - feat: improve session resume reliability and persist user settings
  - perf: increase terminal scrollback from 5,000 to 20,000 lines
  - fix: resolve terminal resize scrollback ghost renders
  - fix: route shell sessions to correct endpoint on tab click
  - fix: correct claudeSessionId for resumed sessions (use original Claude conversation ID)
  - fix: increase default desktop font size from 12 to 14
  - refactor: extract shared \_fetchHistorySessions() method to eliminate duplication
  - refactor: remove dead DEC 2026 sync code (extractSyncSegments, DEC_SYNC_START/END constants)

## 0.3.9

### Patch Changes

- Add content-hash cache busting for static assets — build step now renames JS/CSS files with MD5 content hashes (e.g. app.js → app.94b71235.js) and rewrites index.html references. HTML served with Cache-Control: no-cache so browsers always revalidate and pick up new hashed filenames after deploys. Hashed assets keep immutable 1-year cache. Eliminates the need for manual hard refresh (Ctrl+Shift+R) after deployments.

  Refactor path traversal validation into shared validatePathWithinBase() helper in route-helpers.ts, replacing 6 duplicate inline checks across case-routes, plan-routes, and session-routes.

  Deduplicate stripAnsi in bash-tool-parser.ts — use shared utility from utils/index.ts instead of private method.

## 0.3.8

### Patch Changes

- Add tunnel status indicator with control panel — green pulsing dot in header when Cloudflare tunnel is active, dropdown with URL, remote clients, auth sessions, and start/stop/QR/revoke controls

## 0.3.7

### Patch Changes

- Operation Lightspeed: 5 parallel performance optimizations — multi-layer backpressure to prevent terminal write freezes, TERMINAL_TAIL_SIZE constant with client-drop recovery, tab switching SSE gating, and local echo improvements
- Codebase cleanup: remove dead code (unused token validation exports, PlanPhase alias), add execPattern() regex helper to eliminate repetitive .lastIndex resets, centralize 11 magic number constants into config files, fix CLAUDE.md inaccuracies, and add 316 new tests for utilities, respawn helpers, and system-routes

## 0.3.6

### Patch Changes

- Re-enable WebGL renderer with 48KB/frame flush cap protection against GPU stalls

## 0.3.5

### Patch Changes

- Fix Chrome "page unresponsive" crashes caused by xterm.js WebGL renderer GPU stalls during heavy terminal output. Disable WebGL by default (canvas renderer used instead), gate SSE terminal writes during tab switches, and add crash diagnostics with server-side breadcrumb collection.

## 0.3.4

### Patch Changes

- Fix Chrome tab freeze from flicker filter buffer accumulation during active sessions, and fix shell mode feedback delay by excluding shell sessions from cursor-up filter

## 0.3.3

### Patch Changes

- fix: eliminate WebGL re-render flicker during tab switch by keeping renderer active instead of toggling it off/on around large buffer writes

## 0.3.2

### Patch Changes

- Make file browser panel draggable by its header

## 0.3.1

### Patch Changes

- LLM context optimization and performance improvements: compress CLAUDE.md 21%, MEMORY.md 61%; SSE broadcast early return, cached tunnel state, cache invalidation fix, ralph todo cleanup timer; frontend SSE listener leak fix, short ID caching, subagent window handle cleanup; 100% @fileoverview coverage

## 0.3.0

### Minor Changes

- QR code authentication for tunnel access, 7-phase codebase refactor (route extraction, type domain modules, frontend module split, config consolidation, managed timers, test infrastructure), overlay rendering fixes, and security hardening

## 0.2.9

### Patch Changes

- System-level performance optimizations (Phase 4): stream parent transcripts instead of full reads, consolidate subagent file watchers from 500 to ~50 using directory-level inotify, incremental state persistence with per-session JSON caching, and replace team watcher polling with chokidar fs events

## 0.2.8

### Patch Changes

- Remove 159 lines of dead code: unused interfaces, functions, config constants, legacy no-op timer, and stale barrel re-exports

## 0.2.7

### Patch Changes

- Fix race condition in StateStore where dirty flag was overwritten after async write, silently discarding mutations
- Fix PlanOrchestrator session leak by adding session.stop() in finally blocks and centralizing cleanup
- Fix symlink path traversal in file-content and file-raw endpoints by adding realpathSync validation
- Fix PTY exit handler to clean up sessionListenerRefs, transcriptWatchers, runSummaryTrackers, and terminal batching state
- Fix sendInput() fire-and-forget by propagating runPrompt errors to task queue via taskError event
- Fix Ralph Loop tick() race condition by running checkTimeouts/assignTasks sequentially with per-iteration error handling
- Fix shell injection in hook scripts by piping HOOK_DATA via printf to curl stdin instead of inline embedding
- Narrow tail-file allowlist to remove ~/.cache and ~/.local/share paths that exposed credentials
- Fix stored XSS in quick-start dropdown by escaping case names with escapeHtml()

## 0.2.6

### Patch Changes

- Disable tunnel auto-start on boot; tunnel now only starts when user clicks the UI toggle

## 0.2.5

### Patch Changes

- Fix 3 minor memory leaks: clear respawn timers in stop(), clean up persistDebounceTimers on session cleanup, reset \_parentNameCache on SSE reconnect

## 0.2.4

### Patch Changes

- Fix tunnel button not working: settings PUT was rejected by strict Zod validation when sending full settings blob; now sends only `{tunnelEnabled}`. Added polling fallback for tunnel status in case SSE events are missed.

## 0.2.3

### Patch Changes

- Fix tunnel button stuck on "Connecting..." when tunnel is already running on the server

## 0.2.2

### Patch Changes

- Update CLAUDE.md app.js line count references

## 0.2.1

### Patch Changes

- Integrate @changesets/cli for automated releases with changelogs, GitHub Releases, and npm publishing

## 0.2.0

### Minor Changes

- Initial public release with changesets-based versioning
