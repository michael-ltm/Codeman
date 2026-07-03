/**
 * @fileoverview listDirsSafe — the pure, security-critical directory browser
 * behind the fleet `list-dirs` RPC (protocol.ts) and the
 * `GET /api/fleet/devices/:deviceId/dirs` REST route (fleet-routes.ts).
 *
 * The node-side working-directory picker (spec §12.1/§12.5) lets a dashboard
 * user step through a remote device's filesystem one level at a time. Because
 * the request path arrives over the wire, this function is the ONLY trust
 * boundary — every rule here is a defense against a caller walking out of the
 * user's home directory:
 *
 * - Default path = $HOME (homeDir arg, else `$HOME`, else os.homedir()).
 * - Both the home root AND the requested path are `realpathSync`-resolved, so a
 *   symlink anywhere in the path can't be used to escape: the resolved target
 *   MUST be the home realpath or a descendant of it, else `Error('Path outside
 *   home')` (covers `../` traversal, absolute escapes, and symlink-directory
 *   escapes uniformly). A non-existent path realpaths-throws → same rejection.
 * - Only DIRECTORY names are returned (never files, never file contents), via
 *   `lstatSync` so symlink entries are naturally excluded (a symlink is not a
 *   directory under lstat) — a symlink can't smuggle an outside target into the
 *   listing.
 * - Dot-prefixed entries are excluded; entries whose lstat fails are skipped.
 * - Names are sorted alphabetically and capped at MAX_DIR_ENTRIES (200).
 *
 * Key export: listDirsSafe.
 */

import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';

/** Hard cap on the number of directory names returned for one listing. */
export const MAX_DIR_ENTRIES = 200;

/** Thrown (message-stable) whenever the resolved path escapes the home realpath. */
export const PATH_OUTSIDE_HOME = 'Path outside home';

/**
 * List the immediate subdirectories of `requestedPath` (default `$HOME`),
 * confined to the user's home directory. Returns the canonical resolved path
 * plus alphabetically-sorted directory names (dotdirs/files/symlinks excluded,
 * capped at 200). Throws `Error('Path outside home')` for any path that
 * resolves outside home (traversal / absolute escape / symlink escape / missing).
 */
export function listDirsSafe(requestedPath: string | undefined, homeDir?: string): { path: string; dirs: string[] } {
  const home = homeDir ?? process.env.HOME ?? homedir();
  // Resolve the home root to its canonical form; if home itself is bad we have
  // no safe base to compare against, so this legitimately throws upward.
  const homeReal = realpathSync(home);

  // Empty/undefined → default to home. Relative requests resolve UNDER home
  // (so they can't be interpreted against an unrelated cwd); absolute requests
  // are taken as-is and then validated by the containment check below.
  const target =
    !requestedPath || requestedPath.length === 0
      ? homeReal
      : isAbsolute(requestedPath)
        ? requestedPath
        : join(homeReal, requestedPath);

  let resolved: string;
  try {
    resolved = realpathSync(target);
  } catch {
    // Non-existent path (or a broken symlink) — treat as an invalid request.
    throw new Error(PATH_OUTSIDE_HOME);
  }

  // Containment: resolved must be the home root or a descendant of it. The
  // `sep` guard prevents a sibling like `/home/user-evil` matching `/home/user`.
  if (resolved !== homeReal && !resolved.startsWith(homeReal + sep)) {
    throw new Error(PATH_OUTSIDE_HOME);
  }

  // Must be an actual directory (a file inside home is not a valid browse target).
  if (!statSync(resolved).isDirectory()) {
    throw new Error(PATH_OUTSIDE_HOME);
  }

  const dirs: string[] = [];
  for (const name of readdirSync(resolved)) {
    if (name.startsWith('.')) continue; // hidden entries excluded
    let entry;
    try {
      // lstat (NOT stat): a symlink reports isDirectory() === false here, so
      // symlink entries — inside or outside home — are excluded from results.
      entry = lstatSync(join(resolved, name));
    } catch {
      continue; // unreadable entry — skip
    }
    if (entry.isDirectory()) dirs.push(name);
  }

  dirs.sort((a, b) => a.localeCompare(b));
  return { path: resolved, dirs: dirs.slice(0, MAX_DIR_ENTRIES) };
}
