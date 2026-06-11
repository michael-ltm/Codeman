/**
 * @fileoverview Shared sensitive-path blocklist.
 *
 * A small defense-in-depth blocklist of absolute paths that must never be
 * served to the browser regardless of how the path was obtained (workspace
 * download, cross-workspace attachment registration, raw/preview serving).
 *
 * This is intentionally a BLOCKLIST, not a workspace-confinement check:
 * cross-workspace attachment is a supported feature (codeman-publish skill +
 * the automated review-card loop attaching files under ~/.codeman/), so a
 * strict session-workspace boundary would break legitimate use. The blocklist
 * rejects well-known secret locations (system password files, SSH keys, cloud
 * credentials, dotenv files) while leaving ordinary cross-workspace files
 * attachable.
 *
 * Callers MUST resolve symlinks (realpath) BEFORE calling isSensitivePath so a
 * symlink pointing at a sensitive target is also caught.
 */

import { homedir } from 'node:os';

const SENSITIVE_PATTERNS: RegExp[] = [
  /^\/etc\/shadow$/,
  /^\/etc\/gshadow$/,
  /^\/etc\/master\.passwd$/,
  new RegExp(`^${homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/\\.ssh\\/`),
  /\/\.env$/,
  /\/\.env\./,
  /\/credentials(\.json|\.yml|\.yaml|\.xml)?$/i,
  /\/\.aws\/credentials$/,
  /\/\.gcloud\/credentials\.db$/,
  /\/\.docker\/config\.json$/,
];

/**
 * Returns true if the given ABSOLUTE, symlink-resolved path matches the
 * sensitive-file blocklist and must not be served to the browser.
 */
export function isSensitivePath(absPath: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(absPath));
}
