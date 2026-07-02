/**
 * @fileoverview Tests for fleet-routes.ts — the REST surface for the fleet
 * dashboard (Task 12): aggregate state, device pairing, and per-device session
 * lifecycle (create/stop/read-terminal). `FleetCentralController` and
 * `DeviceRegistry` are mocked (vi.fn()) — their own behavior is covered by
 * test/fleet/central-controller.test.ts and test/fleet/device-registry.test.ts
 * respectively; this file only verifies fleet-routes.ts's own HTTP surface:
 * request shaping, response envelope, and error-status mapping (409 offline /
 * 504 timeout / 422 CLI-unavailable / 400 validation).
 *
 * Uses createRouteTestHarness() (test/routes/_route-test-utils.ts), with a
 * registerFn that ALSO installs the production uniform-envelope
 * preSerialization hook (copied verbatim from src/web/server.ts — same
 * pattern as session-routes.test.ts / case-routes.test.ts, since the plain
 * harness doesn't wrap bare handler returns), so responses are asserted
 * through the real {success,data} envelope rather than the bare return value.
 *
 * Uses app.inject() — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createRouteTestHarness } from './_route-test-utils.js';
import { registerFleetRoutes } from '../../src/web/routes/fleet-routes.js';
import { httpStatusForErrorCode, type ApiErrorCode } from '../../src/types.js';
import type { FleetDeviceHandle } from '../../src/fleet/device-adapter.js';
import type {
  CreateFleetSessionRequest,
  FleetCapabilities,
  FleetDashboardState,
  FleetSessionSummary,
} from '../../src/fleet/protocol.js';

const CAPABILITIES: FleetCapabilities = { tmux: true, claude: true, codex: false, shell: true };

function makeSession(overrides: Partial<FleetSessionSummary> = {}): FleetSessionSummary {
  return {
    deviceId: 'dev_1',
    id: 'sess_1',
    mode: 'claude',
    status: 'idle',
    workingDir: '/tmp/proj',
    pid: 123,
    createdAt: 1000,
    lastActivityAt: 1000,
    ...overrides,
  };
}

function makeDashboardState(overrides: Partial<FleetDashboardState> = {}): FleetDashboardState {
  return {
    devices: [
      {
        id: 'dev_1',
        name: 'macmini',
        hostname: 'macmini.local',
        platform: 'darwin',
        arch: 'arm64',
        username: 'runner',
        version: '1.0.0',
        status: 'online',
        lastSeenAt: 1000,
        activeSessionCount: 1,
        capabilities: CAPABILITIES,
      },
    ],
    sessions: [makeSession()],
    sessionTabs: [],
    generatedAt: 1000,
    ...overrides,
  };
}

/** Minimal controllable fake FleetDeviceHandle — mirrors the fake used in fleet-ws-routes.test.ts. */
function makeHandle(overrides: Partial<FleetDeviceHandle> = {}): FleetDeviceHandle {
  return {
    deviceId: 'dev_1',
    summary: vi.fn(),
    listSessions: vi.fn(async () => []),
    createSession: vi.fn(async (input: CreateFleetSessionRequest) =>
      makeSession({ workingDir: input.workingDir, name: input.name })
    ),
    stopSession: vi.fn(async () => {}),
    writeInput: vi.fn(),
    resize: vi.fn(),
    subscribeTerminal: vi.fn(() => () => {}),
    getTerminalBuffer: vi.fn(async () => 'buffered-output'),
    ...overrides,
  } as FleetDeviceHandle;
}

/** Mock FleetCentralController — only the methods fleet-routes.ts calls directly. */
class MockController {
  getDashboardState = vi.fn(async (): Promise<FleetDashboardState> => makeDashboardState());
  getHandle = vi.fn((_deviceId: string): FleetDeviceHandle | null => null);
  isOnline = vi.fn((_deviceId: string): boolean => false);
}

/** Mock DeviceRegistry — only the methods fleet-routes.ts calls directly. */
class MockRegistry {
  createPairingCode = vi.fn(() => ({ code: 'ABCD2345', expiresAt: 1_700_000_000_000 }));
  consumePairingCode = vi.fn((code: string, _device: unknown) => {
    if (code !== 'VALIDCODE') throw new Error('Pairing code invalid or expired');
    return { deviceId: 'dev_new', token: 'secret-token-abc' };
  });
}

interface Harness {
  app: FastifyInstance;
  controller: MockController;
  registry: MockRegistry;
}

/**
 * Builds the route harness via createRouteTestHarness() (fastifyCookie +
 * installRouteErrorHandler + app.ready()), additionally installing the same
 * uniform-envelope preSerialization hook src/web/server.ts installs in
 * production (copied verbatim — see case-routes.test.ts / session-routes.test.ts
 * for the identical pattern) so bare handler returns become
 * `{success:true,data}` and thrown `{statusCode,body}` errors are asserted
 * through the real envelope shape.
 */
async function createFleetHarness(): Promise<Harness> {
  const controller = new MockController();
  const registry = new MockRegistry();

  const { app } = await createRouteTestHarness((fastifyApp: FastifyInstance) => {
    fastifyApp.addHook('preSerialization', (req, reply, payload: unknown, done) => {
      if (!req.url.startsWith('/api')) return done(null, payload);
      if (payload === null || typeof payload !== 'object') return done(null, payload);
      if (Buffer.isBuffer(payload) || typeof (payload as { pipe?: unknown }).pipe === 'function') {
        return done(null, payload);
      }
      const p = payload as { success?: unknown; errorCode?: unknown };
      if (p.success === false) {
        if (reply.statusCode === 200 && typeof p.errorCode === 'string') {
          reply.code(httpStatusForErrorCode(p.errorCode as ApiErrorCode));
        }
        return done(null, payload);
      }
      if (p.success === true) return done(null, payload);
      return done(null, { success: true, data: payload });
    });
    registerFleetRoutes(fastifyApp, { controller: controller as never, registry: registry as never });
  });

  return { app, controller, registry };
}

describe('fleet-routes', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createFleetHarness();
  });

  afterEach(async () => {
    await harness.app.close();
  });

  // ========== GET /api/fleet ==========

  describe('GET /api/fleet', () => {
    it('returns controller.getDashboardState() through the envelope', async () => {
      const state = makeDashboardState({ generatedAt: 42 });
      harness.controller.getDashboardState.mockResolvedValueOnce(state);

      const res = await harness.app.inject({ method: 'GET', url: '/api/fleet' });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.data).toEqual(state);
    });
  });

  // ========== GET /api/fleet/devices ==========

  describe('GET /api/fleet/devices', () => {
    it('derives {devices, sessions} from getDashboardState()', async () => {
      const state = makeDashboardState();
      harness.controller.getDashboardState.mockResolvedValueOnce(state);

      const res = await harness.app.inject({ method: 'GET', url: '/api/fleet/devices' });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toEqual({ devices: state.devices, sessions: state.sessions });
    });
  });

  // ========== POST /api/fleet/pairing-codes ==========

  describe('POST /api/fleet/pairing-codes', () => {
    it('returns a code, expiresAt, and a joinCommand built from the request host', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/fleet/pairing-codes',
        headers: { host: 'dashboard.example.com:3100' },
      });

      expect(res.statusCode).toBe(200);
      const { data } = res.json();
      expect(data.code).toBe('ABCD2345');
      expect(data.expiresAt).toBe(1_700_000_000_000);
      expect(data.joinCommand).toContain('dashboard.example.com:3100');
      expect(data.joinCommand).toContain('ABCD2345');
      expect(data.joinCommand).toMatch(/^codeman node join /);
    });
  });

  // ========== POST /api/fleet/pair ==========

  describe('POST /api/fleet/pair', () => {
    const device = {
      name: 'node-1',
      hostname: 'node-1.local',
      platform: 'linux',
      arch: 'x64',
      username: 'runner',
      version: '1.0.0',
      capabilities: CAPABILITIES,
    };

    it('valid code returns {deviceId, token}', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/fleet/pair',
        payload: { code: 'VALIDCODE', device },
      });

      expect(res.statusCode).toBe(200);
      const { data } = res.json();
      expect(data).toEqual({ deviceId: 'dev_new', token: 'secret-token-abc' });
    });

    it('invalid code returns 400 with the registry error message', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/fleet/pair',
        payload: { code: 'BOGUS', device },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/invalid or expired/i);
    });

    it('rejects a malformed body (missing device) with 400 before touching the registry', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/fleet/pair',
        payload: { code: 'VALIDCODE' },
      });

      expect(res.statusCode).toBe(400);
      expect(harness.registry.consumePairingCode).not.toHaveBeenCalled();
    });
  });

  // ========== POST /api/fleet/devices/:deviceId/sessions ==========

  describe('POST /api/fleet/devices/:deviceId/sessions', () => {
    const requestBody: CreateFleetSessionRequest = { workingDir: '/tmp/proj', mode: 'claude' };

    it('returns 409 "Device is offline" when the device is offline', async () => {
      harness.controller.getHandle.mockReturnValueOnce(null);
      harness.controller.isOnline.mockReturnValueOnce(false);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/fleet/devices/dev_1/sessions',
        payload: requestBody,
      });

      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.error).toBe('Device is offline');
    });

    it('passes through handle.createSession() when the device is online', async () => {
      const created = makeSession({ id: 'sess_new', workingDir: requestBody.workingDir });
      const handle = makeHandle({ createSession: vi.fn(async () => created) });
      harness.controller.getHandle.mockReturnValueOnce(handle);
      harness.controller.isOnline.mockReturnValueOnce(true);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/fleet/devices/dev_1/sessions',
        payload: requestBody,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toEqual(created);
      expect(handle.createSession).toHaveBeenCalledWith(requestBody);
    });

    it('maps a node RPC timeout ("Fleet node request timed out") to 504', async () => {
      const handle = makeHandle({
        createSession: vi.fn(async () => {
          throw new Error('Fleet node request timed out');
        }),
      });
      harness.controller.getHandle.mockReturnValueOnce(handle);
      harness.controller.isOnline.mockReturnValueOnce(true);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/fleet/devices/dev_1/sessions',
        payload: requestBody,
      });

      expect(res.statusCode).toBe(504);
    });

    it('maps a CLI-unavailable error (e.g. "tmux unavailable") to 422 with the message passed through', async () => {
      const handle = makeHandle({
        createSession: vi.fn(async () => {
          throw new Error('tmux unavailable on this device');
        }),
      });
      harness.controller.getHandle.mockReturnValueOnce(handle);
      harness.controller.isOnline.mockReturnValueOnce(true);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/fleet/devices/dev_1/sessions',
        payload: requestBody,
      });

      expect(res.statusCode).toBe(422);
      const body = res.json();
      expect(body.error).toBe('tmux unavailable on this device');
    });

    it('rejects a body missing workingDir with 400 and never calls createSession', async () => {
      const handle = makeHandle();
      harness.controller.getHandle.mockReturnValueOnce(handle);
      harness.controller.isOnline.mockReturnValueOnce(true);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/fleet/devices/dev_1/sessions',
        payload: { mode: 'claude' },
      });

      expect(res.statusCode).toBe(400);
      expect(handle.createSession).not.toHaveBeenCalled();
    });
  });

  // ========== DELETE /api/fleet/devices/:deviceId/sessions/:sessionId ==========

  describe('DELETE /api/fleet/devices/:deviceId/sessions/:sessionId', () => {
    it('calls handle.stopSession and returns { ok: true }', async () => {
      const handle = makeHandle();
      harness.controller.getHandle.mockReturnValueOnce(handle);
      harness.controller.isOnline.mockReturnValueOnce(true);

      const res = await harness.app.inject({
        method: 'DELETE',
        url: '/api/fleet/devices/dev_1/sessions/sess_1',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toEqual({ ok: true });
      expect(handle.stopSession).toHaveBeenCalledWith('sess_1');
    });
  });

  // ========== GET /api/fleet/devices/:deviceId/sessions/:sessionId/terminal ==========

  describe('GET /api/fleet/devices/:deviceId/sessions/:sessionId/terminal', () => {
    it('passes through handle.getTerminalBuffer()', async () => {
      const handle = makeHandle({ getTerminalBuffer: vi.fn(async () => 'hello world') });
      harness.controller.getHandle.mockReturnValueOnce(handle);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/fleet/devices/dev_1/sessions/sess_1/terminal',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toEqual({ buffer: 'hello world' });
    });

    it('returns an empty buffer when the node cannot provide one', async () => {
      const handle = makeHandle({
        getTerminalBuffer: vi.fn(async () => {
          throw new Error('no buffer capability');
        }),
      });
      harness.controller.getHandle.mockReturnValueOnce(handle);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/fleet/devices/dev_1/sessions/sess_1/terminal',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toEqual({ buffer: '' });
    });
  });
});
