# aicodeman

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
