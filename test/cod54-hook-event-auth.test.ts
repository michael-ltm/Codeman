/**
 * @fileoverview COD-54 — hook-event auth bypass hardening.
 *
 * The `/api/hook-event` localhost bypass let tunnel traffic (cloudflared
 * --url http://127.0.0.1:port) reach the loopback origin with req.ip ===
 * 127.0.0.1 and drive respawn/Ralph signals unauthenticated. The fix gates
 * the bypass behind a shared hook secret WHEN A TUNNEL IS RUNNING, while
 * keeping the plain localhost bypass for the normal loopback-only case so
 * already-deployed (pre-secret) hooks and the loop's own channel keep working.
 *
 * Tests:
 *  - tunnel running + no secret  → 401 (closes the hole)
 *  - tunnel running + bad secret → 401
 *  - tunnel running + good secret → not 401 (allowed)
 *  - tunnel NOT running + no secret → not 401 (back-compat regression guard)
 *  - rate limiting: rapid unauthorized hook POSTs eventually 429
 *
 * Port: 3230 (tunnel-running), 3231 (tunnel-down), 3232 (rate-limit)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { WebServer } from '../src/web/server.js';
import { TmuxManager } from '../src/tmux-manager.js';
import { TunnelManager } from '../src/tunnel-manager.js';
import { getHookSecret, HOOK_SECRET_HEADER } from '../src/config/hook-secret.js';
import { AUTH_FAILURE_MAX } from '../src/config/auth-config.js';

const TUNNEL_UP_PORT = 3230;
const TUNNEL_DOWN_PORT = 3231;
const RATE_LIMIT_PORT = 3232;
const TEST_USER = 'admin';
const TEST_PASS = 'cod54-test-password';

vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);

function hookBody(): string {
  return JSON.stringify({ event: 'stop', sessionId: 'nonexistent-session', data: {} });
}

async function postHook(baseUrl: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}/api/hook-event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: hookBody(),
  });
}

describe('COD-54 hook-event auth — tunnel running requires secret', () => {
  let server: WebServer;
  let baseUrl: string;
  let isRunningSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    process.env.CODEMAN_PASSWORD = TEST_PASS;
    process.env.CODEMAN_USERNAME = TEST_USER;
    // Force the middleware's tunnel check to report "running".
    isRunningSpy = vi.spyOn(TunnelManager.prototype, 'isRunning').mockReturnValue(true);
    server = new WebServer(TUNNEL_UP_PORT, false, true);
    await server.start();
    baseUrl = `http://localhost:${TUNNEL_UP_PORT}`;
  });

  afterAll(async () => {
    await server.stop();
    isRunningSpy.mockRestore();
    delete process.env.CODEMAN_PASSWORD;
    delete process.env.CODEMAN_USERNAME;
  });

  it('rejects a localhost hook POST WITHOUT the secret header (closes the tunnel hole)', async () => {
    const res = await postHook(baseUrl);
    expect(res.status).toBe(401);
  });

  it('rejects a localhost hook POST with a WRONG secret', async () => {
    const res = await postHook(baseUrl, { [HOOK_SECRET_HEADER]: 'wrong-secret-value' });
    expect(res.status).toBe(401);
  });

  it('allows a localhost hook POST WITH the correct secret', async () => {
    const res = await postHook(baseUrl, { [HOOK_SECRET_HEADER]: getHookSecret() });
    // Passes auth (may 200 with success:false for unknown session) — key is NOT 401.
    expect(res.status).not.toBe(401);
  });
});

describe('COD-54 hook-event auth — tunnel down keeps localhost bypass (back-compat)', () => {
  let server: WebServer;
  let baseUrl: string;
  let isRunningSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    process.env.CODEMAN_PASSWORD = TEST_PASS;
    process.env.CODEMAN_USERNAME = TEST_USER;
    // Tunnel NOT running — loopback-only normal prod case.
    isRunningSpy = vi.spyOn(TunnelManager.prototype, 'isRunning').mockReturnValue(false);
    server = new WebServer(TUNNEL_DOWN_PORT, false, true);
    await server.start();
    baseUrl = `http://localhost:${TUNNEL_DOWN_PORT}`;
  });

  afterAll(async () => {
    await server.stop();
    isRunningSpy.mockRestore();
    delete process.env.CODEMAN_PASSWORD;
    delete process.env.CODEMAN_USERNAME;
  });

  it('still allows a localhost hook POST WITHOUT a secret (existing hooks + loop channel keep working)', async () => {
    const res = await postHook(baseUrl);
    expect(res.status).not.toBe(401);
  });
});

describe('COD-54 hook-event auth — rate limiting', () => {
  let server: WebServer;
  let baseUrl: string;
  let isRunningSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    process.env.CODEMAN_PASSWORD = TEST_PASS;
    process.env.CODEMAN_USERNAME = TEST_USER;
    // Tunnel running so unauthorized (no-secret) hook POSTs are rejected and counted.
    isRunningSpy = vi.spyOn(TunnelManager.prototype, 'isRunning').mockReturnValue(true);
    server = new WebServer(RATE_LIMIT_PORT, false, true);
    await server.start();
    baseUrl = `http://localhost:${RATE_LIMIT_PORT}`;
  });

  afterAll(async () => {
    await server.stop();
    isRunningSpy.mockRestore();
    delete process.env.CODEMAN_PASSWORD;
    delete process.env.CODEMAN_USERNAME;
  });

  it('eventually returns 429 for rapid unauthorized hook POSTs', async () => {
    let saw429 = false;
    // A few more than the failure max to cross the threshold.
    for (let i = 0; i < AUTH_FAILURE_MAX + 3; i++) {
      const res = await postHook(baseUrl);
      if (res.status === 429) {
        saw429 = true;
        expect(res.headers.get('retry-after')).toMatch(/^\d+$/);
        break;
      }
      expect(res.status).toBe(401);
    }
    expect(saw429).toBe(true);
  });

  it('hook-secret failures do NOT lock out the Basic-Auth login path (separate bucket)', async () => {
    // The previous test exhausted the hook bucket for 127.0.0.1. Legacy (pre-secret)
    // hooks fire constantly, so if they shared authFailures, every cookie-less
    // request from loopback would now 429 — locking out login (and, via a tunnel,
    // every client). Assert the login path is unaffected:
    // 1. A credential-less request still gets a 401 challenge, NOT 429.
    const unauthed = await fetch(`${baseUrl}/api/status`);
    expect(unauthed.status).toBe(401);
    // 2. Correct Basic credentials still authenticate.
    const authed = await fetch(`${baseUrl}/api/status`, {
      headers: { Authorization: 'Basic ' + Buffer.from(`${TEST_USER}:${TEST_PASS}`).toString('base64') },
    });
    expect(authed.status).toBe(200);
  });
});

describe('COD-54 secret delivery — generated hooks + session env present the secret', () => {
  it('generated hook curl commands send the secret header, read from the file at exec time', async () => {
    const { generateHooksConfig } = await import('../src/hooks-config.js');
    const config = generateHooksConfig();
    const commands = JSON.stringify(config);
    // Header present, value sourced from $CODEMAN_HOOK_SECRET_FILE (not embedded).
    expect(commands).toContain(HOOK_SECRET_HEADER);
    expect(commands).toContain('$CODEMAN_HOOK_SECRET_FILE');
    expect(commands).not.toContain(getHookSecret());
  });

  it('session env builders export CODEMAN_HOOK_SECRET_FILE (path only, never the value)', async () => {
    const { buildClaudeEnv, buildShellEnv } = await import('../src/session-cli-builder.js');
    const claudeEnv = buildClaudeEnv('test-session');
    const shellEnv = buildShellEnv('test-session');
    expect(claudeEnv.CODEMAN_HOOK_SECRET_FILE).toMatch(/hook-secret$/);
    expect(shellEnv.CODEMAN_HOOK_SECRET_FILE).toMatch(/hook-secret$/);
    expect(JSON.stringify(claudeEnv)).not.toContain(getHookSecret());
  });
});
