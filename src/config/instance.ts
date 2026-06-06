/**
 * @fileoverview Per-instance isolation: data directory + tmux socket.
 *
 * Codeman keeps all runtime state under `~/.codeman` and runs its tmux sessions
 * on a dedicated socket (`tmux -L codeman`). Both are PROCESS-WIDE and SHARED by
 * every Codeman instance on the machine — so a second instance pointed at the
 * same socket will discover and attach to the first instance's live sessions,
 * and two instances sharing `~/.codeman/state.json` will clobber each other.
 *
 * To let a beta build coexist with a production one, this module derives both
 * the data dir and the tmux socket from a single "instance" name:
 *   - default (this branch): `beta` → `~/.codeman-beta` + `tmux -L codeman-beta`
 *   - `CODEMAN_INSTANCE=`     (empty) → `~/.codeman`     + `tmux -L codeman`   (prod layout)
 *   - `CODEMAN_INSTANCE=foo`          → `~/.codeman-foo`  + `tmux -L codeman-foo`
 *
 * Individual overrides still win: `CODEMAN_DATA_DIR` (absolute data dir) and
 * `CODEMAN_TMUX_SOCKET` (socket name, validated in tmux-manager).
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

/**
 * Instance name. Empty string = production layout (`~/.codeman`, `-L codeman`).
 * Defaults to `beta` on the beta/session-detach branch so it never collides
 * with a production Codeman. Set `CODEMAN_INSTANCE=` (empty) to opt back into
 * the production layout.
 */
export const CODEMAN_INSTANCE = process.env.CODEMAN_INSTANCE ?? 'beta';

const INSTANCE_SUFFIX = CODEMAN_INSTANCE ? `-${CODEMAN_INSTANCE}` : '';

/** Default tmux socket for this instance. `CODEMAN_TMUX_SOCKET` still overrides. */
export const DEFAULT_TMUX_SOCKET = `codeman${INSTANCE_SUFFIX}`;

let _ensured = false;

/**
 * Absolute path to this instance's data directory (created on first use). All
 * persisted state (`state.json`, `mux-sessions.json`, settings, push keys,
 * lifecycle log, screenshots, certs, …) lives here.
 */
export function getDataDir(): string {
  const dir = process.env.CODEMAN_DATA_DIR || join(homedir(), `.codeman${INSTANCE_SUFFIX}`);
  if (!_ensured) {
    try {
      mkdirSync(dir, { recursive: true });
      _ensured = true;
    } catch {
      /* best-effort; individual writers also mkdir as needed */
    }
  }
  return dir;
}

/** Join one or more segments onto this instance's data directory. */
export function dataPath(...segments: string[]): string {
  return join(getDataDir(), ...segments);
}
