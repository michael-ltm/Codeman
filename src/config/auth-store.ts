/**
 * @fileoverview Hashed-password credential store for the custom login page (COD:
 * see docs/superpowers/specs/2026-07-03-custom-auth-login.md, "后端 → 密码存储").
 *
 * Persists `{ username, passwordHash, salt, algo: 'scrypt', updatedAt }` to
 * `dataPath('auth.json')` (0600, atomic tmp+rename — mirrors
 * `src/fleet/device-registry.ts`'s `saveNow` pattern). When `auth.json` is
 * present and well-formed it is the SOLE source of truth; otherwise credentials
 * fall back to the legacy env vars `CODEMAN_USERNAME` (default `admin`) /
 * `CODEMAN_PASSWORD`. A corrupt/unparseable/malformed `auth.json` is treated as
 * absent (never thrown out of any exported function) so a damaged file degrades
 * to the env fallback instead of locking an operator out.
 *
 * All secret comparisons (username AND password) are timing-safe:
 * - Username, and env-sourced passwords, are compared by SHA-256-hashing both
 *   sides to a fixed 32-byte digest and running `crypto.timingSafeEqual` on
 *   the digests — this avoids leaking length information through an
 *   early-exit length check while still supporting arbitrary-length inputs.
 * - `auth.json`-sourced passwords are compared via `scryptSync` (same salt)
 *   against the stored hash, also via `timingSafeEqual` (both buffers are the
 *   fixed scrypt keylen, so no length-based branch is needed).
 * - `verifyCredentials` NEVER short-circuits on a username mismatch: it always
 *   runs the (slow) password derivation and combines the username/password
 *   results with a non-short-circuiting bitwise AND, so a valid username is
 *   timing-indistinguishable from an invalid one (see the fn doc for why).
 *
 * No caching: every exported function re-reads `auth.json` from disk. Auth
 * checks are low-frequency (login attempts, occasional route middleware
 * checks), so the simplicity of "always fresh" outweighs the cost of a cache
 * invalidation path — and it means `setPassword()` takes effect immediately
 * for the very next `verifyCredentials()` call, including across a process
 * restart, with no extra plumbing.
 *
 * Every function accepts an optional trailing `filePath` (defaults to
 * `dataPath('auth.json')`) so tests can point at a tmpdir instead of the real
 * `~/.codeman` — mirrors the constructor-injected path in `device-registry.ts`.
 */

import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dataPath } from './instance.js';

/** scrypt derived-key length in bytes (matches the stored `passwordHash` hex length: 64 * 2 = 128 chars). */
const SCRYPT_KEYLEN = 64;
/** Random salt length in bytes. */
const SALT_BYTES = 16;

const HEX_RE = /^[0-9a-fA-F]+$/;

interface StoredAuth {
  username: string;
  /** hex-encoded scrypt derived key */
  passwordHash: string;
  /** hex-encoded random salt */
  salt: string;
  algo: 'scrypt';
  updatedAt: number;
}

function defaultPath(): string {
  return dataPath('auth.json');
}

/**
 * Read + validate `auth.json`. Returns `null` if the file is missing,
 * unparseable, or missing/malformed any required field — callers treat that
 * identically to "no auth.json" and fall back to env credentials.
 */
function readAuthFile(filePath: string): StoredAuth | null {
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<StoredAuth>;
    if (
      typeof parsed.username === 'string' &&
      parsed.username.length > 0 &&
      typeof parsed.passwordHash === 'string' &&
      HEX_RE.test(parsed.passwordHash) &&
      // Exactly SCRYPT_KEYLEN bytes — pins the derived-key length so the scrypt
      // path in verifyCredentials always derives a fixed 64-byte key (a bad
      // length would otherwise vary the scrypt cost or crash it).
      parsed.passwordHash.length === SCRYPT_KEYLEN * 2 &&
      typeof parsed.salt === 'string' &&
      HEX_RE.test(parsed.salt) &&
      parsed.salt.length % 2 === 0 &&
      parsed.algo === 'scrypt'
    ) {
      return {
        username: parsed.username,
        passwordHash: parsed.passwordHash,
        salt: parsed.salt,
        algo: 'scrypt',
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
      };
    }
    return null;
  } catch {
    // Corrupt/unparseable JSON — tolerate, fall back to env (device-registry convention).
    return null;
  }
}

/** Timing-safe equality for two UTF-8 strings of arbitrary (possibly unequal) length. */
function timingSafeEqualStrings(a: string, b: string): boolean {
  const aHash = createHash('sha256').update(a, 'utf8').digest();
  const bHash = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(aHash, bHash);
}

/**
 * Verify a username/password pair against the active credential source.
 * `auth.json` wins when present and well-formed; otherwise falls back to
 * `CODEMAN_USERNAME` (default `admin`) / `CODEMAN_PASSWORD`. Returns `false`
 * (never throws) if no password is configured anywhere.
 *
 * Constant-time by construction: on BOTH paths the username check and the
 * password check are computed into separate 0/1 flags — the password
 * derivation (scrypt for `auth.json`, SHA-256 for env) ALWAYS runs regardless
 * of whether the username matched — then combined with a **non-short-circuiting**
 * bitwise AND. A `&&` here would skip the password compare on username mismatch,
 * so a wrong username (fast) would be timing-distinguishable from a correct
 * username with a wrong password (slow scrypt), leaking username validity to a
 * remote attacker. Running both compares unconditionally closes that channel.
 */
export function verifyCredentials(username: string, password: string, filePath: string = defaultPath()): boolean {
  const stored = readAuthFile(filePath);
  if (stored) {
    // Compute both flags up front; do NOT early-return on username mismatch.
    const usernameOk = timingSafeEqualStrings(username, stored.username) ? 1 : 0;
    // Always derive the scrypt key (against the real stored hash) even when the
    // username is wrong, so the slow path is taken uniformly. readAuthFile has
    // already pinned passwordHash to SCRYPT_KEYLEN bytes, so the derive length
    // is fixed; the try/catch keeps the never-throw invariant if scrypt ever
    // rejects (e.g. memory limits) — it is NOT dead (scryptSync can throw).
    let passwordOk = 0;
    try {
      const saltBuf = Buffer.from(stored.salt, 'hex');
      const hashBuf = Buffer.from(stored.passwordHash, 'hex');
      const derived = scryptSync(password, saltBuf, hashBuf.length);
      passwordOk = timingSafeEqual(derived, hashBuf) ? 1 : 0;
    } catch {
      passwordOk = 0;
    }
    return (usernameOk & passwordOk) === 1; // non-short-circuiting AND
  }

  // Fall back to env credentials.
  const envPassword = process.env.CODEMAN_PASSWORD;
  if (!envPassword) return false;
  const envUsername = process.env.CODEMAN_USERNAME || 'admin';
  // Symmetric shape: run both compares, combine without short-circuit. The env
  // path's leak is tiny (SHA-256 vs SHA-256) but keeping it identical avoids a
  // future refactor reintroducing an early return.
  const usernameOk = timingSafeEqualStrings(username, envUsername) ? 1 : 0;
  const passwordOk = timingSafeEqualStrings(password, envPassword) ? 1 : 0;
  return (usernameOk & passwordOk) === 1;
}

/**
 * Hash + persist a new password for `username`, overwriting any existing
 * `auth.json`. Atomic write (tmp + rename), 0600 permissions.
 */
export function setPassword(username: string, newPassword: string, filePath: string = defaultPath()): void {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(newPassword, salt, SCRYPT_KEYLEN);
  const stored: StoredAuth = {
    username,
    passwordHash: hash.toString('hex'),
    salt: salt.toString('hex'),
    algo: 'scrypt',
    updatedAt: Date.now(),
  };

  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(stored, null, 2), { mode: 0o600 });
  try {
    // Explicit chmod: writeFileSync's `mode` is masked by umask, so force 0600
    // regardless of the process umask (belt-and-suspenders; no-op-ish on Windows).
    chmodSync(tmp, 0o600);
  } catch {
    /* best-effort */
  }
  renameSync(tmp, filePath); // atomic
  try {
    chmodSync(filePath, 0o600);
  } catch {
    /* best-effort */
  }
}

/** True if a password is configured via `auth.json` OR `CODEMAN_PASSWORD`. */
export function isPasswordConfigured(filePath: string = defaultPath()): boolean {
  if (readAuthFile(filePath)) return true;
  return !!process.env.CODEMAN_PASSWORD;
}

/** The active username: `auth.json`'s if present, else `CODEMAN_USERNAME` or `admin`. */
export function getConfiguredUsername(filePath: string = defaultPath()): string {
  const stored = readAuthFile(filePath);
  if (stored) return stored.username;
  return process.env.CODEMAN_USERNAME || 'admin';
}
