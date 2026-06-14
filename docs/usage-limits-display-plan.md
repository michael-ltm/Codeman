# Plan Usage Limits Display — Design Plan

> **Status: IMPLEMENTED — disabled by default (2026-06-14, not yet committed/COM'd).** Surface the user's Claude subscription **plan usage limits** (5-hour rolling + 7-day weekly windows: percent used + reset time) in the Codeman web UI via a Codeman-managed `statusLine` callback. Opt-in via App Settings → Display → **Plan Usage Limits** (`showPlanUsageLimits`, default OFF). The `rate_limits` JSON schema below was **empirically confirmed** against Claude Code 2.1.177 on a Claude Max account (2026-06-14); see the Verification appendix to reproduce.
>
> **Shipped surface:** pure parser `src/usage-telemetry.ts` (+ `test/usage-telemetry.test.ts`); `applyStatusLineConfig`/`generateStatusLineCommand` in `hooks-config.ts`; `POST /api/status-telemetry` (`status-telemetry-routes.ts`, auth-exempt in `middleware/auth.ts`, schema in `schemas.ts`); SSE `session:statusTelemetry`; create-payload `statusLineTelemetry` gate in `session-routes.ts`; header chip + `applyHeaderVisibilitySettings` toggle + `renderIndexHtml` strip + `_onSessionStatusTelemetry` handler. Verified: typecheck, lint, full test suite (2866 pass), and live (endpoint/settings/render-strip on an isolated instance).

## Problem

Codeman has no proactive view of how much of the Claude subscription is left. Today it only learns about limits **reactively**: `usage-limit-patterns.ts` regex-scrapes ANSI-stripped terminal output for footer strings like `5-hour limit reached ∙ resets 8pm`, and extracts only the **reset time** — and only *after* Claude has already stalled. There is no "73% of your 5-hour limit used" anywhere.

We want a live gauge:

```
5-hour limit ▕███▏              15%   resets 8:50am
7-day limit  ▕███████▏          34%   resets Fri
```

So the operator can see a wall coming, pace overnight Ralph/autonomous runs, and (future) pre-arm auto-resume instead of waiting for the stall.

## Current state (verified in code)

| Piece | File | Behavior |
|-------|------|----------|
| Reactive scraper | `src/usage-limit-patterns.ts` | Pure regex over cleaned PTY output; detects limit footers, parses **reset time only**. Conservative (no reset time → ignored). |
| Auto-resume | `src/session-auto-ops.ts` | Arms a timer at reset+2min, sends Esc + `continue`. Persists via `SessionState.autoResumeEnabled/autoResumeAt`. |
| SSE events (existing) | `src/web/sse-events.ts` | `session:limitPauseScheduled`, `session:limitResume`, `session:limitResumeCancelled`. |
| Settings injection | `src/hooks-config.ts` | Writes `hooks` (+ `env`/`model`) into each case's `.claude/settings.local.json`. **No `statusLine` is ever written** (confirmed via grep). |

Codeman therefore has **zero access to Claude Code's structured usage data** — it has never configured a statusLine, which is the channel that data flows through.

## Data source: the statusline `rate_limits` JSON

Claude Code (**v2.1.80+**; prod box runs **2.1.177**) pipes a JSON blob to a configured `statusLine.command` on stdin after each render. On Pro/Max subscriptions that blob includes `rate_limits`.

### Confirmed schema (real captured payload)

```jsonc
"rate_limits": {
  "five_hour": { "used_percentage": 15, "resets_at": 1781409000 },  // → 2026-06-14T03:50:00Z
  "seven_day": { "used_percentage": 34, "resets_at": 1781827200 }   // → 2026-06-19T00:00:00Z
}
```

| Field | Type | Notes |
|-------|------|-------|
| `rate_limits.five_hour.used_percentage` | `number` 0–100 | Integer-valued in practice; treat as `number`, don't assume decimals. |
| `rate_limits.five_hour.resets_at` | `number` | **Epoch SECONDS** (10 digits). `×1000` for a JS `Date`. |
| `rate_limits.seven_day.{used_percentage,resets_at}` | same | |

**Confirmed facts & gotchas:**

- **Only two windows exist: `five_hour` and `seven_day`.** There is **no separate Opus-weekly field**, even on a Max/Opus account. Do **not** promise an Opus gauge in the UI.
- `rate_limits` is **absent on the first render**, **present after the first API response**. UI must degrade to "usage not yet available."
- statusLine fires **only in interactive TUI mode**, never `--print`. Fine — Codeman sessions are interactive TUIs.
- **Subscriber-gated.** Absent for API-key / non-subscriber auth.

### Bonus telemetry in the same payload (free to surface)

The same stdin object also carries (non-sensitive):

```jsonc
"model":          { "id": "claude-opus-4-8[1m]", "display_name": "Opus 4.8 (1M context)" },
"context_window": { "context_window_size": 1000000, "used_percentage": 2, "remaining_percentage": 98,
                    "current_usage": { "input_tokens": …, "output_tokens": …,
                                       "cache_creation_input_tokens": …, "cache_read_input_tokens": … } },
"cost":           { "total_cost_usd": 0.0415, "total_duration_ms": …, "total_api_duration_ms": …,
                    "total_lines_added": 0, "total_lines_removed": 0 },
"effort":         { "level": "xhigh" },
"fast_mode": false, "exceeds_200k_tokens": false,
"session_name": "…", "session_id": "…", "transcript_path": "…", "version": "…"
```

One statusLine callback thus unlocks live **context-window %**, **per-session cost**, **model**, **effort**, and **fast-mode** alongside the plan limits — a meaningful expansion of what the feature can show.

### Alternatives considered & rejected

| Source | Why not |
|--------|---------|
| OAuth endpoint `api.anthropic.com/api/oauth/usage` | Undocumented, aggressively rate-limited, needs extracting the **encrypted** OAuth token. Only worth it for *dollar spend* data the statusline lacks. |
| `/usage` slash command | Interactive-only, no programmatic output. |
| On-disk `~/.claude/` files | No usage state persisted (verified: only `daemon.status.json` = auto-updater supervisor). |
| CLI flag (`claude usage` / `--check-usage`) | Does not exist (open upstream feature request). |
| `StopFailure` hook | Carries only an `error_type` (`rate_limit`) on *failure* — no live percentages. Could complement, not replace. |

## Design

A Codeman-managed `statusLine.command` that mirrors the existing hook-callback pattern: it POSTs the full stdin payload to a new loopback endpoint and prints whatever the server returns as the visible status text.

```
Claude TUI (managed case)
  │  renders statusline (~300ms debounce, after each assistant msg)
  ▼
statusLine.command  ──reads stdin JSON──▶  curl POST $CODEMAN_API_URL/api/sessions/:id/statusline
  │                                          (X-Codeman-Hook-Secret: $(cat $CODEMAN_HOOK_SECRET_FILE))
  │  ◀── HTTP 200 body = formatted status string ──┘
  ▼
printf '%s' "$body"   →  in-terminal statusline stays useful ("Opus 4.8 · 5h 15% · 7d 34%")

server: parse payload → extract rate_limits/context_window/cost/model
        → store on Session → broadcast SSE → format & return status string
  ▼
SSE  session:statusTelemetry  →  app.js listener  →  header/Respawn-tab gauge
```

### 1. The exporter (reuses hook plumbing)

Mirror `curlCmd()` in `hooks-config.ts`. The managed-session env already carries `$CODEMAN_SESSION_ID`, `$CODEMAN_API_URL`, and `$CODEMAN_HOOK_SECRET_FILE` (set by `tmux-manager.buildEnvExports()`), which the hooks already rely on — the statusLine command inherits the same env. No `jq` dependency: POST the **raw** stdin and let the server parse. The server's HTTP response body is the status string to print, so formatting lives server-side and the in-terminal statusline stays useful even when attached directly (`sc`):

```bash
# conceptual — generated into settings.local.json statusLine.command
PAYLOAD=$(cat 2>/dev/null || echo '{}')
BODY=$(printf '%s' "$PAYLOAD" | curl -s -X POST "$CODEMAN_API_URL/api/sessions/$CODEMAN_SESSION_ID/statusline" \
  -H 'Content-Type: application/json' \
  -H "X-Codeman-Hook-Secret: $(cat "$CODEMAN_HOOK_SECRET_FILE" 2>/dev/null)" \
  --data @- 2>/dev/null || true)
printf '%s' "${BODY:-codeman}"   # fallback keeps a sane statusline if the server is down
```

### 2. Settings injection (opt-in, Claude-only)

Add a `statusLine` block to `generateHooksConfig()` (or a sibling) in `hooks-config.ts`, gated by a new opt-in app setting (e.g. `showPlanUsageLimits`) and only for Claude-mode cases (OpenCode/Codex emit no such JSON — gate exactly like the hooks). Merge into `settings.local.json` touching only the `statusLine` key, same as `writeHooksConfig()` merges `hooks`.

### 3. New endpoint

`POST /api/sessions/:id/statusline` in `src/web/routes/session-routes.ts`:
- Zod schema in `schemas.ts` validates the subset Codeman cares about (`rate_limits`, `context_window`, `cost`, `model`, `effort`) — all `.optional()`/`.nullish()` since fields come and go (⚠️ recall: `.optional()` rejects `null`; the payload is machine-generated so unlikely, but use `.passthrough()`/`.nullish()` defensively).
- Auth: exempt like `/api/hook-event` (localhost-only), gated by `X-Codeman-Hook-Secret` while a tunnel is up (reuse `config/hook-secret.ts`). Dedicated rate-limit bucket — **never** the login bucket (COD-55 lesson).
- Returns the formatted status string in the response body.
- **Debounce/dedup:** statusline renders ~every 300ms. Server should ignore payloads with no `rate_limits` change and avoid re-broadcasting unchanged telemetry, to keep SSE quiet.

### 4. SSE event

Add `session:statusTelemetry` (or `account:rateLimits`) to `src/web/sse-events.ts` **and** the `SSE_EVENTS` mirror in `constants.js` (both must stay in sync), emit via `broadcast()`, handle in `app.js` (`addListener(`).

### 5. State

Store last-seen telemetry on the `Session` (e.g. `_lastStatusTelemetry`), include in `session.toState()`, persist via `persistSessionState()` so a reload re-renders immediately. See *account-global* caveat below for whether to also keep a global singleton.

### 6. Frontend

A compact gauge component (two bars: 5h / 7d, percent + humanized reset). Natural home: the **header** (account-global) or beside the existing token-pause / auto-resume control at the top of the **Respawn tab** (`respawn-ui.js`). Reset time = `resets_at * 1000` → `new Date(...)`; render relative ("resets in 2h14m") with absolute on hover.

## Codeman-specific considerations

1. **The limits are account-global, not per-session.** The 5h/7d pools are shared across every session authenticated as the same Claude account. So all sessions report the **same** numbers → prefer a **single global widget** (freshest sample wins) over a per-tab bar showing identical values. Caveat: if different sessions ever use different Claude accounts (rare — one machine usually = one login), keep per-session storage and label the global widget with the account/most-recent source.

2. **Settings-override risk.** `settings.local.json.statusLine` **overrides** the user's own `~/.claude/settings.json` statusLine inside managed sessions. The print-through design (§1) mitigates the visible degradation; keeping the feature **opt-in** avoids surprising users who have a custom statusline. (Managed Ralph/autonomous cases are rarely viewed in-terminal anyway — the web UI is the real surface.)

3. **Subscriber + post-first-response gating.** Degrade gracefully when `rate_limits` is absent (API-key auth, free tier, or before the first response). Keep `usage-limit-patterns.ts` as the **fallback** for older CLIs / non-subscribers.

4. **Security stays in the existing envelope.** The exporter runs arbitrary shell every render, but that's the same trust model as the hook curls (localhost + `$CODEMAN_HOOK_SECRET_FILE`). No new exposure; reuse the hook secret and a separate rate-limit bucket.

5. **External CLI modes.** OpenCode/Codex render their own TUIs and emit no `rate_limits` JSON. Gate the statusLine injection to Claude mode only (`isExternalCliMode()` guard), exactly as Ralph/BashToolParser are gated.

6. **Synergy with auto-resume (future).** Live percentages let `SessionAutoOps` pre-arm *before* the wall (e.g. at 100% projected) rather than only reacting to the stall footer, and let the UI show "limit imminent." Out of scope for v1 but the data makes it trivial later.

## Implementation surface area (checklist)

- [ ] `src/hooks-config.ts` — generate a `statusLine` block (opt-in setting, Claude-only); merge into `settings.local.json`.
- [ ] `src/web/routes/session-routes.ts` — `POST /api/sessions/:id/statusline` (auth-exempt + hook-secret + dedicated rate-limit bucket), returns formatted status string.
- [ ] `src/web/schemas.ts` — Zod schema for the telemetry subset (`.nullish()`/passthrough).
- [ ] `src/web/sse-events.ts` + `src/web/public/constants.js` — new SSE event (keep in sync).
- [ ] `SessionState` + `session.toState()` + `persistSessionState()` — persist last telemetry.
- [ ] Frontend gauge + `app.js` listener; placement in header or `respawn-ui.js`.
- [ ] App Settings toggle `showPlanUsageLimits` (Display section), reload-on-toggle (statusLine is settings-injected at session create / via `writeHooksConfig`).
- [ ] Tests: pure formatter (percent + reset humanizer) unit-tested like `usage-limit-patterns.test.ts`; route test via `app.inject()`.

## Open questions / risks

- **Schema stability.** `rate_limits` is an officially-shipped statusline field but undocumented in exact shape; a future CC version could add windows (e.g. an Opus field) or rename keys. The server parser should be tolerant (ignore unknown windows, render whatever windows exist) rather than hard-coding only `five_hour`/`seven_day`.
- **Re-injection timing.** Toggling the setting must (re)write `statusLine` into existing cases or only new sessions — decide whether to push to live cases via `writeHooksConfig`-style update or require a respawn.
- **Multi-account.** See consideration #1 — confirm whether any real deployment runs sessions under different Claude logins before committing to a single global widget.

## Verification appendix — how the schema was captured (reproducible)

Captured without touching global settings or any real session:

1. Throwaway dir `/tmp/sl-capture` with an exporter `dump.sh` that appends stdin to `payloads.jsonl` and prints `cap`; a `settings.json` pointing `statusLine.command` at it.
2. `--print` mode does **not** render a statusline → no capture (confirms TUI-only). Must use interactive.
3. Launch interactive Claude in an **isolated tmux socket** (`tmux -L slcap`, never `-L codeman`) inside the temp dir, `--settings /tmp/sl-capture/settings.json` (no global mutation). Confirm the workspace-trust dialog (appears even with `--dangerously-skip-permissions`), then send a one-line prompt (literal text + Enter separately, Ink-style).
4. After the first response, `rate_limits` appears in the **second** captured record (absent in the first). Inspect with `jq '.rate_limits'`.
5. Tear down: `tmux -L slcap kill-server` + `rm -rf /tmp/sl-capture`; verify the `codeman` socket is untouched.

Related: `docs/claude-code-hooks-reference.md` (hook callback pattern), `src/usage-limit-patterns.ts` (reactive fallback), `docs/respawn-state-machine.md` (auto-resume interplay).
