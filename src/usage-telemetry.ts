/**
 * @fileoverview Pure parsing + formatting of Claude Code statusline telemetry.
 *
 * Claude Code (v2.1.80+) pipes a JSON blob to a configured `statusLine.command`
 * on each render. On Pro/Max subscriptions that blob carries a `rate_limits`
 * object with the 5-hour rolling and 7-day weekly plan windows. The
 * Codeman-managed statusLine exporter (see `hooks-config.generateStatusLineCommand`)
 * POSTs that blob to `/api/status-telemetry`; these helpers normalize the subset
 * Codeman displays and format the compact in-terminal footer string.
 *
 * Confirmed schema (empirically captured, CC 2.1.177, Claude Max — see
 * `docs/usage-limits-display-plan.md`):
 *   rate_limits.{five_hour,seven_day}.{used_percentage: number 0-100,
 *                                      resets_at: number EPOCH-SECONDS}
 * Only those two windows exist (no Opus-weekly field). `rate_limits` is absent
 * before the first API response and for non-subscriber auth — both yield null.
 *
 * All functions are pure for testability. See `test/usage-telemetry.test.ts`.
 *
 * @module usage-telemetry
 */

/** A single normalized plan-usage window. */
export interface UsageWindow {
  /** Percent of the window consumed, 0–100. */
  usedPercentage: number;
  /** Epoch MILLISECONDS when the window resets (statusline reports seconds). */
  resetAt: number;
}

/** Normalized telemetry Codeman broadcasts to the UI. */
export interface StatusTelemetry {
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  /** Context-window percent used, 0–100 (bonus field from the same payload). */
  contextUsedPercentage?: number;
  /** Session cost in USD (bonus field). */
  costUsd?: number;
  /** Model display name, e.g. "Opus 4.8 (1M context)" (bonus field). */
  modelDisplayName?: string;
}

/** Raw subset of the statusline stdin JSON (snake_case, as Claude emits it). */
export interface RawStatuslinePayload {
  rate_limits?: {
    five_hour?: { used_percentage?: number; resets_at?: number };
    seven_day?: { used_percentage?: number; resets_at?: number };
  };
  context_window?: { used_percentage?: number };
  cost?: { total_cost_usd?: number };
  model?: { display_name?: string };
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function parseWindow(w?: { used_percentage?: number; resets_at?: number }): UsageWindow | undefined {
  if (!w || typeof w.used_percentage !== 'number' || typeof w.resets_at !== 'number') return undefined;
  if (!Number.isFinite(w.resets_at) || w.resets_at <= 0) return undefined;
  return { usedPercentage: clampPct(w.used_percentage), resetAt: Math.round(w.resets_at * 1000) };
}

/**
 * Normalize a raw statusline payload to the telemetry Codeman displays. Returns
 * null when there is no plan-limit data to show (pre-first-response or a
 * non-subscriber account) so the caller can skip broadcasting.
 */
export function parseStatusTelemetry(data: RawStatuslinePayload | undefined): StatusTelemetry | null {
  if (!data) return null;
  const fiveHour = parseWindow(data.rate_limits?.five_hour);
  const sevenDay = parseWindow(data.rate_limits?.seven_day);
  if (!fiveHour && !sevenDay) return null;

  const t: StatusTelemetry = {};
  if (fiveHour) t.fiveHour = fiveHour;
  if (sevenDay) t.sevenDay = sevenDay;
  if (typeof data.context_window?.used_percentage === 'number') {
    t.contextUsedPercentage = clampPct(data.context_window.used_percentage);
  }
  if (typeof data.cost?.total_cost_usd === 'number' && Number.isFinite(data.cost.total_cost_usd)) {
    t.costUsd = data.cost.total_cost_usd;
  }
  if (typeof data.model?.display_name === 'string' && data.model.display_name) {
    t.modelDisplayName = data.model.display_name.slice(0, 60);
  }
  return t;
}

/** Compact in-terminal footer text (statusLine stdout / print-through). */
export function formatStatusLineText(t: StatusTelemetry | null): string {
  if (!t) return 'codeman';
  const parts: string[] = [];
  if (t.fiveHour) parts.push(`5h ${Math.round(t.fiveHour.usedPercentage)}%`);
  if (t.sevenDay) parts.push(`7d ${Math.round(t.sevenDay.usedPercentage)}%`);
  return parts.length ? `⟳ ${parts.join(' · ')}` : 'codeman';
}

/**
 * Stable signature for change-detection — the statusline fires on every
 * assistant message, so the route only rebroadcasts when this value changes.
 */
export function telemetrySignature(t: StatusTelemetry): string {
  return JSON.stringify([
    t.fiveHour?.usedPercentage ?? null,
    t.fiveHour?.resetAt ?? null,
    t.sevenDay?.usedPercentage ?? null,
    t.sevenDay?.resetAt ?? null,
    t.contextUsedPercentage ?? null,
  ]);
}
