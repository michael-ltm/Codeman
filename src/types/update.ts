/**
 * @fileoverview Types for the in-app self-updater.
 *
 * Codeman can update itself from the web UI (App Settings → Updates). The flow
 * is driven by a detached `scripts/self-update.sh` that outlives the service
 * restart it triggers, and a status file at `~/.codeman/update-status.json`
 * (see `dataPath('update-status.json')`) that the browser polls across the
 * restart boundary.
 *
 * Backend logic: `src/web/self-update.ts`. Routes: `src/web/routes/system-routes.ts`
 * (`/api/system/update/check`, `POST /api/system/update`, `/api/system/update/status`).
 *
 * @module types/update
 */

/**
 * Which init system supervises the running server (decides how we restart it).
 * `launchd-daemon` = a KeepAlive system-level LaunchDaemon (headless Macs, no GUI
 * login): restart works by killing the server and letting launchd respawn it.
 */
export type SupervisorKind = 'systemd' | 'launchd' | 'launchd-daemon' | 'none';

/** How Codeman was installed — only `git` installs can self-update in place. */
export type InstallKind = 'git' | 'npm' | 'unknown';

/**
 * Lifecycle of a single update run. `idle`/`completed`/`failed`/
 * `completed-needs-manual-restart` are terminal; the rest are in-flight.
 */
export type UpdatePhase =
  | 'idle'
  | 'queued'
  | 'preparing'
  | 'stashing'
  | 'fetching'
  | 'checkout'
  | 'installing'
  | 'building'
  | 'restarting'
  | 'completed'
  | 'completed-needs-manual-restart'
  | 'failed';

/** Persisted update progress, written atomically by the updater + boot reconcile. */
export interface UpdateStatus {
  /** Nonce identifying this run; guards boot-reconcile against stale/foreign status. */
  updateId: string;
  phase: UpdatePhase;
  /** Human-readable one-liner for the UI. */
  message: string;
  /** Version the server was on when the update started. */
  fromVersion: string;
  /** Target version (parsed from the release tag). */
  toVersion?: string;
  /** Target git tag, e.g. `codeman@0.9.4`. */
  toTag?: string;
  /** Commit the repo was on before the update, for rollback. */
  prevSha?: string;
  /** Name of the stash holding local changes (when the tree was dirty), else null. */
  stashRef?: string | null;
  supervisor?: SupervisorKind;
  /** epoch ms — update start (freshness guard for boot reconcile). */
  startedAt: number;
  /** epoch ms — last write. */
  updatedAt: number;
  /** Populated on failure. */
  error?: string;
  /** Shown for the `none` supervisor — the command the user must run by hand. */
  manualRestartCommand?: string;
}

/** Describes the running install — drives whether/how the Updates UI is shown. */
export interface InstallInfo {
  installKind: InstallKind;
  installDir: string;
  /** Current git branch, or `HEAD` when detached (e.g. pinned to a release tag). */
  branch?: string;
  /** Uncommitted local changes present (true → updater will auto-stash). */
  dirty: boolean;
  supervisor: SupervisorKind;
  currentVersion: string;
  /** False when `CODEMAN_DISABLE_SELF_UPDATE=1`. */
  selfUpdateEnabled: boolean;
}

/** Result of "check for updates" — current vs. latest release. */
export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string | null;
  latestTag: string | null;
  updateAvailable: boolean;
  /** Release notes (markdown) when available from the GitHub API. */
  notes?: string | null;
  /** Link to the release page. */
  htmlUrl?: string | null;
  /** epoch ms of the check. */
  checkedAt: number;
  source: 'github-api' | 'git-ls-remote' | 'none';
  error?: string;
}
