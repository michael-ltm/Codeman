/**
 * Custom login-page auth flow tests (Auth Task B).
 *
 * Verifies the auth.ts overhaul that replaces the native browser Basic-Auth
 * prompt with a self-contained login page + login/change-password routes:
 *  1. curl -u style Basic header still authenticates (regression red line).
 *  2. Unauthenticated page navigation (Accept: text/html) → 200 login page,
 *     NOT a WWW-Authenticate challenge.
 *  3. Unauthenticated /api/* → 401 JSON envelope, no WWW-Authenticate.
 *  4. POST /api/auth/login: correct → cookie + {success:true}; wrong → 401;
 *     rate-limited → 429.
 *  5. POST /api/auth/change-password: unauth → 401 (middleware); wrong current
 *     → 400; short new → 400; valid → {success:true} and verifyCredentials then
 *     reflects the new password.
 *  6. Passwordless instance → GET / still serves the app (no login page).
 *
 * Data-dir isolation: each server points CODEMAN_DATA_DIR at a fresh tmpdir so
 * setPassword/auth.json never touches the real ~/.codeman.
 *
 * Ports: 3240 (main flow), 3241 (change-password), 3242 (login rate limit),
 * 3243 (passwordless).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebServer } from '../src/web/server.js';
import { TmuxManager } from '../src/tmux-manager.js';
import { verifyCredentials } from '../src/config/auth-store.js';

const MAIN_PORT = 3240;
const CHPW_PORT = 3241;
const RATE_PORT = 3242;
const NOPW_PORT = 3243;
const TEST_USER = 'admin';
const TEST_PASS = 'initial-password-123';

vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);

function basicAuthHeader(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'codeman-authb-'));
}

/** Save/restore the auth-relevant env across a describe block. */
function snapshotEnv() {
  return {
    pw: process.env.CODEMAN_PASSWORD,
    user: process.env.CODEMAN_USERNAME,
    dir: process.env.CODEMAN_DATA_DIR,
  };
}
function restoreEnv(s: ReturnType<typeof snapshotEnv>): void {
  s.pw === undefined ? delete process.env.CODEMAN_PASSWORD : (process.env.CODEMAN_PASSWORD = s.pw);
  s.user === undefined ? delete process.env.CODEMAN_USERNAME : (process.env.CODEMAN_USERNAME = s.user);
  s.dir === undefined ? delete process.env.CODEMAN_DATA_DIR : (process.env.CODEMAN_DATA_DIR = s.dir);
}

describe('Custom login flow (password-protected instance)', () => {
  let server: WebServer;
  let baseUrl: string;
  let env: ReturnType<typeof snapshotEnv>;

  beforeAll(async () => {
    env = snapshotEnv();
    process.env.CODEMAN_DATA_DIR = freshDataDir();
    process.env.CODEMAN_PASSWORD = TEST_PASS;
    process.env.CODEMAN_USERNAME = TEST_USER;
    server = new WebServer(MAIN_PORT, false, true);
    await server.start();
    baseUrl = `http://localhost:${MAIN_PORT}`;
  });

  afterAll(async () => {
    await server.stop();
    restoreEnv(env);
  });

  it('still authenticates a curl -u style Basic header (regression)', async () => {
    const res = await fetch(`${baseUrl}/api/status`, {
      headers: { Authorization: basicAuthHeader(TEST_USER, TEST_PASS) },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('codeman_session=');
    // The native browser prompt trigger must be gone.
    expect(res.headers.get('www-authenticate')).toBeNull();
  });

  it('serves the custom login page (200) for an unauthenticated page navigation', async () => {
    const res = await fetch(`${baseUrl}/`, { headers: { Accept: 'text/html' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('www-authenticate')).toBeNull();
    const body = await res.text();
    expect(body).toContain('id="loginForm"');
    expect(body).toContain('/api/auth/login');
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('returns a 401 JSON envelope (no login page, no WWW-Authenticate) for unauthenticated /api/*', async () => {
    const res = await fetch(`${baseUrl}/api/status`);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBeNull();
    const body = await res.json();
    expect(body).toMatchObject({ success: false, errorCode: 'UNAUTHORIZED' });
  });

  it('logs in with correct credentials → sets cookie + {success:true}, cookie then works', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: TEST_USER, password: TEST_PASS }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('codeman_session=');
    const cookie = `codeman_session=${setCookie.match(/codeman_session=([^;]+)/)![1]}`;

    const check = await fetch(`${baseUrl}/api/status`, { headers: { Cookie: cookie } });
    expect(check.status).toBe(200);
  });

  it('rejects a login with wrong credentials → 401', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: TEST_USER, password: 'nope' }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ success: false, errorCode: 'UNAUTHORIZED' });
  });
});

describe('Login rate limiting', () => {
  let server: WebServer;
  let baseUrl: string;
  let env: ReturnType<typeof snapshotEnv>;

  beforeEach(async () => {
    env = snapshotEnv();
    process.env.CODEMAN_DATA_DIR = freshDataDir();
    process.env.CODEMAN_PASSWORD = TEST_PASS;
    process.env.CODEMAN_USERNAME = TEST_USER;
    server = new WebServer(RATE_PORT, false, true);
    await server.start();
    baseUrl = `http://localhost:${RATE_PORT}`;
  });

  afterEach(async () => {
    await server.stop();
    restoreEnv(env);
  });

  it('trips the per-IP limiter → 429 after too many failed logins', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: TEST_USER, password: `wrong-${i}` }),
      });
      expect(res.status).toBe(401);
    }
    const limited = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: TEST_USER, password: 'wrong-again' }),
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toMatch(/^\d+$/);
  });
});

describe('Change password', () => {
  let server: WebServer;
  let baseUrl: string;
  let dataDir: string;
  let env: ReturnType<typeof snapshotEnv>;
  let cookie: string;

  beforeAll(async () => {
    env = snapshotEnv();
    dataDir = freshDataDir();
    process.env.CODEMAN_DATA_DIR = dataDir;
    process.env.CODEMAN_PASSWORD = TEST_PASS;
    process.env.CODEMAN_USERNAME = TEST_USER;
    server = new WebServer(CHPW_PORT, false, true);
    await server.start();
    baseUrl = `http://localhost:${CHPW_PORT}`;
    // Authenticate once to obtain a session cookie for the authenticated calls.
    const res = await fetch(`${baseUrl}/api/status`, {
      headers: { Authorization: basicAuthHeader(TEST_USER, TEST_PASS) },
    });
    cookie = `codeman_session=${res.headers.get('set-cookie')!.match(/codeman_session=([^;]+)/)![1]}`;
  });

  afterAll(async () => {
    await server.stop();
    restoreEnv(env);
  });

  it('rejects an UNauthenticated change-password with 401 (middleware gate)', async () => {
    const res = await fetch(`${baseUrl}/api/auth/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: TEST_PASS, newPassword: 'brand-new-pass' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a wrong current password with 400', async () => {
    const res = await fetch(`${baseUrl}/api/auth/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ currentPassword: 'not-the-current', newPassword: 'brand-new-pass' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ success: false, error: expect.stringMatching(/current/i) });
  });

  it('rejects a too-short new password with 400', async () => {
    const res = await fetch(`${baseUrl}/api/auth/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ currentPassword: TEST_PASS, newPassword: 'short' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ success: false, error: expect.stringMatching(/short/i) });
  });

  it('accepts a valid change and verifyCredentials then reflects the new password', async () => {
    const newPass = 'a-fresh-strong-password';
    const res = await fetch(`${baseUrl}/api/auth/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ currentPassword: TEST_PASS, newPassword: newPass }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    const authJson = join(dataDir, 'auth.json');
    expect(verifyCredentials(TEST_USER, newPass, authJson)).toBe(true);
    // auth.json now overrides the env password, so the old one no longer works.
    expect(verifyCredentials(TEST_USER, TEST_PASS, authJson)).toBe(false);
  });
});

describe('Passwordless instance (no CODEMAN_PASSWORD, no auth.json)', () => {
  let server: WebServer;
  let baseUrl: string;
  let env: ReturnType<typeof snapshotEnv>;

  beforeAll(async () => {
    env = snapshotEnv();
    // Fresh empty data dir → no auth.json; no env password → auth inactive.
    process.env.CODEMAN_DATA_DIR = freshDataDir();
    delete process.env.CODEMAN_PASSWORD;
    delete process.env.CODEMAN_USERNAME;
    server = new WebServer(NOPW_PORT, false, true, '127.0.0.1');
    await server.start();
    baseUrl = `http://localhost:${NOPW_PORT}`;
  });

  afterAll(async () => {
    await server.stop();
    restoreEnv(env);
  });

  it('serves the real app (not the login page) for GET / with no auth', async () => {
    const res = await fetch(`${baseUrl}/`, { headers: { Accept: 'text/html' } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('id="loginForm"');
  });

  it('allows /api/status without credentials', async () => {
    const res = await fetch(`${baseUrl}/api/status`);
    expect(res.status).toBe(200);
  });
});
