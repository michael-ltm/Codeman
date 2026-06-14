/**
 * @fileoverview Process-wide last-known plan-usage telemetry (account-global).
 *
 * The status-telemetry route writes the latest broadcast value here; the SSE
 * init snapshot (`getLightState`) replays it so the header "Plan Usage Limits"
 * chip shows immediately on a fresh page load / SSE reconnect — before any new
 * statusline render arrives, and without relying on per-browser localStorage.
 *
 * Null until the first telemetry of the process; cleared naturally on restart.
 *
 * @module plan-usage-latest
 */

let latest: Record<string, unknown> | null = null;

export function setLatestPlanUsage(value: Record<string, unknown>): void {
  latest = value;
}

export function getLatestPlanUsage(): Record<string, unknown> | null {
  return latest;
}
