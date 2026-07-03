/**
 * src/config/auth-store.ts — hashed password persistence for the custom login
 * page (docs/superpowers/specs/2026-07-03-custom-auth-login.md).
 *
 * Isolation: every exported function takes an optional trailing `filePath`
 * (mirrors `DeviceRegistry`'s constructor-injected path in
 * `test/fleet/device-registry.test.ts`), so each test points at a fresh
 * tmpdir file instead of the real `~/.codeman/auth.json`. No env-var/module
 * mocking needed for that half; CODEMAN_USERNAME/CODEMAN_PASSWORD are still
 * plain process.env reads (no module-level caching in auth-store.ts), so
 * tests just set/restore them directly.
 *
 * Port: N/A (no server; pure functions + tmp file IO).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scryptSync } from 'node:crypto';

// Spy on scryptSync while keeping the REAL implementation (so hashing stays
// correct). Lets the constant-time test below assert that the scrypt derivation
// runs even when the username is wrong — i.e. verifyCredentials does NOT
// early-return before the password check, closing the username-timing channel.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, scryptSync: vi.fn(actual.scryptSync) };
});

import {
  getConfiguredUsername,
  isPasswordConfigured,
  setPassword,
  verifyCredentials,
} from '../../src/config/auth-store.js';

const ENV_KEYS = ['CODEMAN_USERNAME', 'CODEMAN_PASSWORD'] as const;
const ORIG: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

describe('config/auth-store', () => {
  let file: string;

  beforeEach(() => {
    file = join(mkdtempSync(join(tmpdir(), 'auth-store-')), 'auth.json');
    clearEnv();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (ORIG[k] === undefined) delete process.env[k];
      else process.env[k] = ORIG[k];
    }
  });

  it('setPassword then verifyCredentials: correct user+pass true; wrong pass/user false', () => {
    setPassword('alice', 'correct-horse-battery', file);
    expect(verifyCredentials('alice', 'correct-horse-battery', file)).toBe(true);
    expect(verifyCredentials('alice', 'wrong-password', file)).toBe(false);
    expect(verifyCredentials('bob', 'correct-horse-battery', file)).toBe(false);
  });

  it('no auth.json + env CODEMAN_PASSWORD set → verifyCredentials uses env', () => {
    process.env.CODEMAN_USERNAME = 'admin';
    process.env.CODEMAN_PASSWORD = 'env-secret';
    expect(isPasswordConfigured(file)).toBe(true);
    expect(getConfiguredUsername(file)).toBe('admin');
    expect(verifyCredentials('admin', 'env-secret', file)).toBe(true);
    expect(verifyCredentials('admin', 'wrong', file)).toBe(false);
    expect(verifyCredentials('someone-else', 'env-secret', file)).toBe(false);
  });

  it('env CODEMAN_USERNAME unset defaults to admin', () => {
    process.env.CODEMAN_PASSWORD = 'env-secret';
    expect(getConfiguredUsername(file)).toBe('admin');
    expect(verifyCredentials('admin', 'env-secret', file)).toBe(true);
  });

  it('no auth.json + no env → isPasswordConfigured false, verifyCredentials false', () => {
    expect(isPasswordConfigured(file)).toBe(false);
    expect(getConfiguredUsername(file)).toBe('admin');
    expect(verifyCredentials('admin', 'anything', file)).toBe(false);
    expect(verifyCredentials('', '', file)).toBe(false);
  });

  it('auth.json present takes precedence over env', () => {
    process.env.CODEMAN_USERNAME = 'envuser';
    process.env.CODEMAN_PASSWORD = 'env-pass-X';
    setPassword('fileuser', 'file-pass-Y', file);

    expect(getConfiguredUsername(file)).toBe('fileuser');
    expect(verifyCredentials('fileuser', 'file-pass-Y', file)).toBe(true);
    // env credentials no longer work once auth.json exists
    expect(verifyCredentials('envuser', 'env-pass-X', file)).toBe(false);
  });

  it('corrupt auth.json falls back to env without throwing', () => {
    writeFileSync(file, '{bad');
    process.env.CODEMAN_USERNAME = 'admin';
    process.env.CODEMAN_PASSWORD = 'env-secret';

    expect(() => verifyCredentials('admin', 'env-secret', file)).not.toThrow();
    expect(verifyCredentials('admin', 'env-secret', file)).toBe(true);
    expect(() => isPasswordConfigured(file)).not.toThrow();
    expect(isPasswordConfigured(file)).toBe(true);
    expect(getConfiguredUsername(file)).toBe('admin');
  });

  it('malformed-but-parseable auth.json (missing fields) falls back to env', () => {
    writeFileSync(file, JSON.stringify({ username: 'x' })); // missing passwordHash/salt/algo
    process.env.CODEMAN_PASSWORD = 'env-secret';
    expect(verifyCredentials('admin', 'env-secret', file)).toBe(true);
  });

  it('auth.json is written 0600', () => {
    if (process.platform === 'win32') return; // POSIX-only permission model
    setPassword('alice', 'pw123456', file);
    const mode = statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('setPassword round-trips through a fresh module read (simulated restart)', async () => {
    setPassword('carol', 'restart-pass', file);

    // Simulate a process restart: re-import the module fresh (auth-store has
    // no module-level cache, so this should behave identically either way —
    // this test asserts that invariant explicitly).
    const fresh = await import('../../src/config/auth-store.js');
    expect(fresh.verifyCredentials('carol', 'restart-pass', file)).toBe(true);
    expect(fresh.getConfiguredUsername(file)).toBe('carol');

    // And the on-disk shape matches the documented contract.
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    expect(onDisk).toMatchObject({
      username: 'carol',
      algo: 'scrypt',
    });
    expect(typeof onDisk.passwordHash).toBe('string');
    expect(typeof onDisk.salt).toBe('string');
    expect(typeof onDisk.updatedAt).toBe('number');
    expect(onDisk.passwordHash).not.toMatch(/restart-pass/);
  });

  it('setPassword overwrites a previous password for the same file', () => {
    setPassword('dave', 'first-pass', file);
    expect(verifyCredentials('dave', 'first-pass', file)).toBe(true);
    setPassword('dave', 'second-pass', file);
    expect(verifyCredentials('dave', 'first-pass', file)).toBe(false);
    expect(verifyCredentials('dave', 'second-pass', file)).toBe(true);
  });

  it('wrong-username and wrong-password both return false (auth.json path)', () => {
    setPassword('erin', 'right-pass', file);
    expect(verifyCredentials('erin', 'wrong-pass', file)).toBe(false); // right user, wrong pass
    expect(verifyCredentials('mallory', 'right-pass', file)).toBe(false); // wrong user, right pass
    expect(verifyCredentials('mallory', 'wrong-pass', file)).toBe(false); // both wrong
    expect(verifyCredentials('erin', 'right-pass', file)).toBe(true); // sanity: both right
  });

  it('constant-time: scrypt derivation runs even on a username mismatch (no early return)', () => {
    setPassword('erin', 'right-pass', file); // this call also invokes scryptSync
    vi.mocked(scryptSync).mockClear();

    // A wrong username must NOT short-circuit before the password derivation —
    // otherwise a valid vs invalid username is timing-distinguishable. Observe
    // the code path: scryptSync fires exactly once even though the username is wrong.
    expect(verifyCredentials('mallory', 'irrelevant', file)).toBe(false);
    expect(scryptSync).toHaveBeenCalledTimes(1);

    // And a correct username with a wrong password takes the same path (one derive).
    vi.mocked(scryptSync).mockClear();
    expect(verifyCredentials('erin', 'wrong-pass', file)).toBe(false);
    expect(scryptSync).toHaveBeenCalledTimes(1);
  });
});
