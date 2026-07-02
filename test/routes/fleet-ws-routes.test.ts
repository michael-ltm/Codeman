/**
 * @fileoverview Tests for the node WebSocket endpoint (`/ws/fleet/node`).
 *
 * Like ws-routes.test.ts, this uses a real listening Fastify server (WS upgrade
 * requests aren't supported by app.inject()) and the `ws` package as the client.
 * The `FleetCentralController` is mocked (vi.fn() members) — this file only
 * verifies the route's own auth/handshake/framing behavior, not the controller's
 * internals (covered by test/fleet/central-controller.test.ts). `DeviceRegistry`
 * is real, backed by a temp file, so a device is paired through the actual
 * pairing flow to get a real deviceId/token pair.
 *
 * @dependency src/web/routes/fleet-ws-routes.ts (registerFleetWsRoutes)
 * Port: 3171
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import WebSocket from 'ws';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerFleetWsRoutes } from '../../src/web/routes/fleet-ws-routes.js';
import { DeviceRegistry } from '../../src/fleet/device-registry.js';
import type { FleetCentralController } from '../../src/fleet/central-controller.js';
import type { FleetCapabilities, FleetSessionSummary, NodeToCentralFrame } from '../../src/fleet/protocol.js';

const PORT = 3171;

const capabilities: FleetCapabilities = { tmux: true, claude: true, codex: false, shell: true };

function makeRegistry(): DeviceRegistry {
  const file = join(mkdtempSync(join(tmpdir(), 'fleet-ws-')), 'fleet-devices.json');
  return new DeviceRegistry(file);
}

/** Pairs a device through the real pairing flow so registry.authenticate() works. */
function pairDevice(reg: DeviceRegistry, name = 'node-1'): { deviceId: string; token: string } {
  const { code } = reg.createPairingCode();
  return reg.consumePairingCode(code, {
    name,
    hostname: `${name}.local`,
    platform: 'linux',
    arch: 'x64',
    username: 'runner',
    version: '1.0.0',
    capabilities,
  });
}

function makeSession(overrides: Partial<FleetSessionSummary> = {}): FleetSessionSummary {
  return {
    deviceId: 'dev_x',
    id: 's1',
    mode: 'claude',
    status: 'idle',
    workingDir: '/tmp',
    pid: 111,
    createdAt: 1000,
    lastActivityAt: 1000,
    ...overrides,
  };
}

function helloFrame(
  deviceId: string,
  sessions: FleetSessionSummary[] = []
): Extract<NodeToCentralFrame, { t: 'hello' }> {
  return {
    t: 'hello',
    protocol: 1,
    device: {
      id: deviceId,
      name: 'node-1',
      hostname: 'node-1.local',
      platform: 'linux',
      arch: 'x64',
      username: 'runner',
      version: '1.0.0',
      status: 'online',
      lastSeenAt: Date.now(),
      activeSessionCount: sessions.filter((s) => s.status !== 'stopped').length,
      capabilities,
    },
    sessions,
  };
}

function makeMockController() {
  return {
    connectNode: vi.fn(),
    disconnectNode: vi.fn(),
    handleNodeFrame: vi.fn(),
  };
}

type MockController = ReturnType<typeof makeMockController>;

/** Helper: open a WebSocket with optional headers and wait for OPEN state. */
function connectWs(path: string, headers?: Record<string, string>, timeoutMs = 5000): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS connection timeout')), timeoutMs);
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}`, headers ? { headers } : undefined);
    ws.on('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Helper: wait for WS close event and return { code, reason }. */
function waitForClose(ws: WebSocket, timeoutMs = 2000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS close timeout')), timeoutMs);
    ws.on('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
    ws.on('error', () => {
      // A connection-refused error before 'open' can race with 'close'; ignore
      // here since waitForClose only cares about the close event outcome.
    });
  });
}

describe('fleet-ws-routes', () => {
  let app: FastifyInstance;
  let registry: DeviceRegistry;
  let controller: MockController;
  let deviceId: string;
  let token: string;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);

    registry = makeRegistry();
    ({ deviceId, token } = pairDevice(registry));
    controller = makeMockController();

    registerFleetWsRoutes(app, {
      controller: controller as unknown as FleetCentralController,
      registry,
      getHostPolicy: () => ({ bindHost: '127.0.0.1', allowedHosts: [], tunnelHost: null }),
    });

    await app.listen({ port: PORT, host: '127.0.0.1' });
  });

  afterEach(async () => {
    await app.close();
  });

  // ========== 1. Authentication ==========

  describe('authentication', () => {
    it('closes 4001 when Authorization header is missing', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/fleet/node`, {
        headers: { 'x-codeman-device-id': deviceId },
      });
      const { code, reason } = await waitForClose(ws);
      expect(code).toBe(4001);
      expect(reason).toBe('Unauthorized');
    });

    it('closes 4001 for a wrong token', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/fleet/node`, {
        headers: { Authorization: 'Bearer wrong-token', 'x-codeman-device-id': deviceId },
      });
      const { code } = await waitForClose(ws);
      expect(code).toBe(4001);
    });

    it('closes 4001 for a spoofed deviceId', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/fleet/node`, {
        headers: { Authorization: `Bearer ${token}`, 'x-codeman-device-id': 'dev_fake_spoof' },
      });
      const { code } = await waitForClose(ws);
      expect(code).toBe(4001);
    });

    it('never calls the controller for an unauthorized connection', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/fleet/node`, {
        headers: { Authorization: 'Bearer wrong-token', 'x-codeman-device-id': deviceId },
      });
      await waitForClose(ws);
      expect(controller.connectNode).not.toHaveBeenCalled();
      expect(controller.disconnectNode).not.toHaveBeenCalled();
    });
  });

  // ========== 2. Hello handshake ==========

  describe('hello handshake', () => {
    it('closes 4002 when the first frame after auth is not hello', async () => {
      const ws = await connectWs('/ws/fleet/node', {
        Authorization: `Bearer ${token}`,
        'x-codeman-device-id': deviceId,
      });
      ws.send(JSON.stringify({ t: 'heartbeat', sessions: [] }));
      const { code, reason } = await waitForClose(ws);
      expect(code).toBe(4002);
      expect(reason).toBe('Expected hello');
    });

    it('closes 4002 when hello.device.id does not match the header deviceId', async () => {
      const ws = await connectWs('/ws/fleet/node', {
        Authorization: `Bearer ${token}`,
        'x-codeman-device-id': deviceId,
      });
      ws.send(JSON.stringify(helloFrame('dev_other_device')));
      const { code } = await waitForClose(ws);
      expect(code).toBe(4002);
    });

    it('closes 4002 for a garbage first frame', async () => {
      const ws = await connectWs('/ws/fleet/node', {
        Authorization: `Bearer ${token}`,
        'x-codeman-device-id': deviceId,
      });
      ws.send('not-json{{{');
      const { code } = await waitForClose(ws);
      expect(code).toBe(4002);
    });
  });

  // ========== 3. Valid hello -> connectNode ==========

  describe('valid hello', () => {
    it('calls controller.connectNode with deviceId, the socket, and the parsed hello frame', async () => {
      const ws = await connectWs('/ws/fleet/node', {
        Authorization: `Bearer ${token}`,
        'x-codeman-device-id': deviceId,
      });
      const session = makeSession({ deviceId, id: 'sess-1' });
      const hello = helloFrame(deviceId, [session]);

      ws.send(JSON.stringify(hello));

      await vi.waitFor(() => {
        expect(controller.connectNode).toHaveBeenCalledTimes(1);
      });

      const [calledDeviceId, , calledHello] = controller.connectNode.mock.calls[0];
      expect(calledDeviceId).toBe(deviceId);
      expect(calledHello).toEqual(hello);
      expect(calledHello.sessions).toEqual([session]);

      ws.close();
      await waitForClose(ws);
    });
  });

  // ========== 4. Post-hello frames -> handleNodeFrame ==========

  describe('post-hello frames', () => {
    it('forwards a parsed heartbeat frame to controller.handleNodeFrame', async () => {
      const ws = await connectWs('/ws/fleet/node', {
        Authorization: `Bearer ${token}`,
        'x-codeman-device-id': deviceId,
      });
      ws.send(JSON.stringify(helloFrame(deviceId)));
      await vi.waitFor(() => expect(controller.connectNode).toHaveBeenCalledTimes(1));

      const heartbeat = { t: 'heartbeat', sessions: [makeSession({ deviceId })] };
      ws.send(JSON.stringify(heartbeat));

      await vi.waitFor(() => {
        expect(controller.handleNodeFrame).toHaveBeenCalledWith(deviceId, heartbeat);
      });

      ws.close();
      await waitForClose(ws);
    });

    it('ignores unparseable frames without closing, and does not forward them', async () => {
      const ws = await connectWs('/ws/fleet/node', {
        Authorization: `Bearer ${token}`,
        'x-codeman-device-id': deviceId,
      });
      ws.send(JSON.stringify(helloFrame(deviceId)));
      await vi.waitFor(() => expect(controller.connectNode).toHaveBeenCalledTimes(1));

      ws.send('garbage-not-json');
      // Confirm connection survives by following up with a valid frame.
      const heartbeat = { t: 'heartbeat', sessions: [] };
      ws.send(JSON.stringify(heartbeat));

      await vi.waitFor(() => {
        expect(controller.handleNodeFrame).toHaveBeenCalledWith(deviceId, heartbeat);
      });
      expect(controller.handleNodeFrame).toHaveBeenCalledTimes(1);

      ws.close();
      await waitForClose(ws);
    });

    it('closes 1003 after 20 consecutive invalid post-hello frames', async () => {
      const ws = await connectWs('/ws/fleet/node', {
        Authorization: `Bearer ${token}`,
        'x-codeman-device-id': deviceId,
      });
      ws.send(JSON.stringify(helloFrame(deviceId)));
      await vi.waitFor(() => expect(controller.connectNode).toHaveBeenCalledTimes(1));

      for (let i = 0; i < 20; i++) {
        ws.send('garbage');
      }

      const { code } = await waitForClose(ws);
      expect(code).toBe(1003);
    });
  });

  // ========== 5. Client disconnect -> disconnectNode ==========

  describe('client disconnect', () => {
    it('calls controller.disconnectNode with deviceId and the IDENTICAL socket passed to connectNode', async () => {
      const ws = await connectWs('/ws/fleet/node', {
        Authorization: `Bearer ${token}`,
        'x-codeman-device-id': deviceId,
      });
      ws.send(JSON.stringify(helloFrame(deviceId)));
      await vi.waitFor(() => expect(controller.connectNode).toHaveBeenCalledTimes(1));
      const socketPassedToConnect = controller.connectNode.mock.calls[0][1];

      ws.close();
      await waitForClose(ws);

      await vi.waitFor(() => {
        expect(controller.disconnectNode).toHaveBeenCalledTimes(1);
      });
      expect(controller.disconnectNode).toHaveBeenCalledWith(deviceId, socketPassedToConnect);
    });
  });
});
