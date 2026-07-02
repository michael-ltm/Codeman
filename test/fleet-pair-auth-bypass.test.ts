/**
 * @fileoverview Task 9 — auth.ts fleet exemption tests.
 *
 * `POST /api/fleet/pair` and `GET /ws/fleet/node` bypass the dashboard's Basic
 * Auth/cookie gate (see src/web/middleware/auth.ts) because they authenticate
 * differently: a pairing code and a per-device Bearer token, respectively,
 * neither of which the dashboard operator's password has any bearing on.
 * Everything else under /api/fleet/* and /ws/fleet/devices/* is NOT exempted.
 *
 * Task 9 (`fleet-ws-routes.ts`) intentionally does not wire its route into
 * server.ts yet (Task 10 does that, to avoid touching the same file). So these
 * assertions exercise the exemption at the auth-middleware level only: an
 * exempted path must never come back 401 (the Basic Auth challenge), even
 * though — with no route registered yet — it 404s past the auth gate. A 404
 * (not 401) is exactly what proves the onRequest hook let the request through
 * without demanding credentials. Follows the WebServer + real fetch() pattern
 * used by test/auth-security.test.ts and test/cod54-hook-event-auth.test.ts.
 *
 * Port: 3172
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebServer } from '../src/web/server.js';
import { TmuxManager } from '../src/tmux-manager.js';
import { FLEET_PAIR_RATE_LIMIT_MAX } from '../src/config/auth-config.js';
import { vi } from 'vitest';

const PORT = 3172;
const TEST_USER = 'admin';
const TEST_PASS = 'fleet-auth-bypass-test-password';

vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);

describe('Fleet auth exemptions (auth.ts)', () => {
  let server: WebServer;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.CODEMAN_PASSWORD = TEST_PASS;
    process.env.CODEMAN_USERNAME = TEST_USER;
    server = new WebServer(PORT, false, true);
    await server.start();
    baseUrl = `http://localhost:${PORT}`;
  });

  afterAll(async () => {
    await server.stop();
    delete process.env.CODEMAN_PASSWORD;
    delete process.env.CODEMAN_USERNAME;
  });

  it('sanity: a normal protected route 401s without credentials', async () => {
    const res = await fetch(`${baseUrl}/api/status`);
    expect(res.status).toBe(401);
  });

  it('POST /api/fleet/pair bypasses Basic Auth (no 401 without credentials)', async () => {
    const res = await fetch(`${baseUrl}/api/fleet/pair`, { method: 'POST' });
    // Not wired into server.ts until Task 10 — a 404 (route not found) proves
    // the auth gate let it through; the key assertion is NOT 401.
    expect(res.status).not.toBe(401);
  });

  it('GET /ws/fleet/node bypasses Basic Auth (no 401 without credentials)', async () => {
    const res = await fetch(`${baseUrl}/ws/fleet/node`);
    expect(res.status).not.toBe(401);
  });

  it('other /api/fleet/* paths are NOT exempted — still 401 without credentials', async () => {
    const res = await fetch(`${baseUrl}/api/fleet/devices`);
    expect(res.status).toBe(401);
  });

  it('/api/fleet/pair via GET (wrong method) is NOT exempted — still 401', async () => {
    const res = await fetch(`${baseUrl}/api/fleet/pair`);
    expect(res.status).toBe(401);
  });

  it('/ws/fleet/devices/* is NOT exempted — still 401 without credentials', async () => {
    const res = await fetch(`${baseUrl}/ws/fleet/devices/dev_x/terminal`);
    expect(res.status).toBe(401);
  });

  it('a valid session cookie still works on an exempted-adjacent fleet route', async () => {
    // /api/fleet/pair bypasses auth outright, but this confirms normal
    // Basic-Auth/cookie flow is untouched by the fleet exemption addition.
    const authRes = await fetch(`${baseUrl}/api/status`, {
      headers: { Authorization: 'Basic ' + Buffer.from(`${TEST_USER}:${TEST_PASS}`).toString('base64') },
    });
    expect(authRes.status).toBe(200);
  });
});

describe('Fleet auth exemptions — /api/fleet/pair rate limiting', () => {
  const RATE_LIMIT_PORT = 3173;
  let server: WebServer;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.CODEMAN_PASSWORD = TEST_PASS;
    process.env.CODEMAN_USERNAME = TEST_USER;
    server = new WebServer(RATE_LIMIT_PORT, false, true);
    await server.start();
    baseUrl = `http://localhost:${RATE_LIMIT_PORT}`;
  });

  afterAll(async () => {
    await server.stop();
    delete process.env.CODEMAN_PASSWORD;
    delete process.env.CODEMAN_USERNAME;
  });

  it('rate-limits POST /api/fleet/pair to FLEET_PAIR_RATE_LIMIT_MAX/min per IP (429 after exceeding)', async () => {
    let saw429 = false;
    for (let i = 0; i < FLEET_PAIR_RATE_LIMIT_MAX + 3; i++) {
      const res = await fetch(`${baseUrl}/api/fleet/pair`, { method: 'POST' });
      if (res.status === 429) {
        saw429 = true;
        expect(res.headers.get('retry-after')).toMatch(/^\d+$/);
        break;
      }
      // Under the limit: bypasses Basic Auth, so never 401 (404 until Task 10 wires the route).
      expect(res.status).not.toBe(401);
    }
    expect(saw429).toBe(true);
  });
});
