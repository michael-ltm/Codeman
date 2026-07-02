/**
 * @fileoverview Tests for the fleet WebSocket endpoints:
 * - `/ws/fleet/node` (Task 9) — the node agent's wire entrypoint.
 * - `/ws/fleet/devices/:deviceId/sessions/:sessionId/terminal` (Task 11) — the
 *   browser-facing remote terminal proxy.
 *
 * Like ws-routes.test.ts, this uses a real listening Fastify server (WS upgrade
 * requests aren't supported by app.inject()) and the `ws` package as the client.
 * The `FleetCentralController` is mocked — a real `node:events` `EventEmitter`
 * subclass with vi.fn() methods, so `controller.on('device-offline', ...)` /
 * `.emit(...)` behave exactly like the real controller (Task 8) while
 * `getHandle`/`isOnline`/`hasSession`/etc. stay fully controllable per test.
 * This file only verifies each route's own auth/handshake/framing behavior, not
 * the controller's internals (covered by test/fleet/central-controller.test.ts).
 * `DeviceRegistry` is real, backed by a temp file, so a device is paired through
 * the actual pairing flow to get a real deviceId/token pair (used by the node
 * endpoint's Bearer auth only — the browser endpoint doesn't touch the registry).
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
import { EventEmitter } from 'node:events';
import { registerFleetWsRoutes } from '../../src/web/routes/fleet-ws-routes.js';
import { DeviceRegistry } from '../../src/fleet/device-registry.js';
import type { FleetCentralController } from '../../src/fleet/central-controller.js';
import type { FleetCapabilities, FleetSessionSummary, NodeToCentralFrame } from '../../src/fleet/protocol.js';
import type { TerminalSink } from '../../src/fleet/local-session-ops.js';

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

/**
 * Mock `FleetCentralController`: a real `EventEmitter` (so `.on('device-offline', ...)`
 * / `.emit(...)` in the route under test behave exactly like the real controller,
 * which itself extends EventEmitter — see central-controller.ts) plus vi.fn()
 * methods for everything the routes call directly.
 */
class MockFleetController extends EventEmitter {
  connectNode = vi.fn();
  disconnectNode = vi.fn();
  handleNodeFrame = vi.fn();
  getHandle = vi.fn();
  isOnline = vi.fn();
  hasSession = vi.fn();
}

function makeMockController(): MockFleetController {
  return new MockFleetController();
}

type MockController = MockFleetController;

/** A controllable fake `FleetDeviceHandle` for the browser terminal WS tests.
 *  `subscribeTerminal` records the sink it's given (and the returned unsub) via
 *  the vi.fn()'s own mock.calls/mock.results, so tests can trigger sink events
 *  and assert the unsub is called on disconnect. */
function makeFakeHandle(deviceId: string) {
  return {
    deviceId,
    summary: vi.fn(),
    listSessions: vi.fn(),
    createSession: vi.fn(),
    stopSession: vi.fn(),
    writeInput: vi.fn(),
    resize: vi.fn(),
    subscribeTerminal: vi.fn((_sessionId: string, _sink: TerminalSink) => vi.fn()),
    getTerminalBuffer: vi.fn(),
  };
}

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

/** Helper: wait for the next WS message, parsed as JSON. */
function nextMessage(ws: WebSocket, timeoutMs = 2000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS message timeout')), timeoutMs);
    ws.once('message', (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(raw)));
    });
  });
}

/** Strips the DEC 2026 synchronized-update wrapper (`\x1b[?2026h` ... `\x1b[?2026l`)
 *  the batching layer wraps every 'o' payload in, so tests can assert on the raw text. */
function stripSync(d: string): string {
  return d.replace(/^\x1b\[\?2026h/, '').replace(/\x1b\[\?2026l$/, '');
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

  // ========== 6. Browser terminal endpoint ==========
  // /ws/fleet/devices/:deviceId/sessions/:sessionId/terminal — see task-11-brief.md.

  describe('browser terminal endpoint', () => {
    const browserDeviceId = 'dev_browser_1';
    const termSessionId = 'sess-1';
    const path = `/ws/fleet/devices/${browserDeviceId}/sessions/${termSessionId}/terminal`;

    let openSockets: WebSocket[];

    beforeEach(() => {
      openSockets = [];
    });

    afterEach(async () => {
      // Safety net: close anything a test left open and wait for the route's
      // 'close' handler to run, so the module-level per-IP counter (and any
      // listener) never leaks into the next test.
      await Promise.all(
        openSockets
          .filter((ws) => ws.readyState !== WebSocket.CLOSED)
          .map((ws) => {
            const closed = waitForClose(ws).catch(() => {});
            ws.close();
            return closed;
          })
      );
    });

    /** Wires the mock controller to report `browserDeviceId` online with `termSessionId`. */
    function setupOnlineDevice() {
      const handle = makeFakeHandle(browserDeviceId);
      controller.getHandle.mockReturnValue(handle);
      controller.isOnline.mockReturnValue(true);
      controller.hasSession.mockReturnValue(true);
      return handle;
    }

    async function connectTerminal(headers?: Record<string, string>): Promise<WebSocket> {
      const ws = await connectWs(path, headers);
      openSockets.push(ws);
      return ws;
    }

    it('closes 4004 for an unknown device (getHandle returns null)', async () => {
      controller.getHandle.mockReturnValue(null);
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}`);
      openSockets.push(ws);
      const { code, reason } = await waitForClose(ws);
      expect(code).toBe(4004);
      expect(reason).toBe('Unknown device or session');
    });

    it('closes 4004 for an offline device (isOnline false)', async () => {
      const handle = makeFakeHandle(browserDeviceId);
      controller.getHandle.mockReturnValue(handle);
      controller.isOnline.mockReturnValue(false);
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}`);
      openSockets.push(ws);
      const { code } = await waitForClose(ws);
      expect(code).toBe(4004);
      expect(handle.subscribeTerminal).not.toHaveBeenCalled();
    });

    it('closes 4004 when hasSession reports the session is not in the device cache', async () => {
      const handle = makeFakeHandle(browserDeviceId);
      controller.getHandle.mockReturnValue(handle);
      controller.isOnline.mockReturnValue(true);
      controller.hasSession.mockReturnValue(false);
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}`);
      openSockets.push(ws);
      const { code } = await waitForClose(ws);
      expect(code).toBe(4004);
      expect(handle.subscribeTerminal).not.toHaveBeenCalled();
    });

    it('closes 4003 for a disallowed Origin', async () => {
      setupOnlineDevice();
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}`, {
        headers: { Origin: 'http://evil.example.com' },
      });
      openSockets.push(ws);
      const { code } = await waitForClose(ws);
      expect(code).toBe(4003);
    });

    it('translates subscribeTerminal sink events to o/c/r frames, batching data with DEC 2026 sync markers', async () => {
      const handle = setupOnlineDevice();
      const ws = await connectTerminal();
      await vi.waitFor(() => expect(handle.subscribeTerminal).toHaveBeenCalledTimes(1));
      const [subscribedSessionId, sink] = handle.subscribeTerminal.mock.calls[0] as [string, TerminalSink];
      expect(subscribedSessionId).toBe(termSessionId);

      let msgPromise = nextMessage(ws);
      sink({ kind: 'data', data: 'hello from device' });
      const dataMsg = (await msgPromise) as { t: string; d: string };
      expect(dataMsg.t).toBe('o');
      expect(dataMsg.d.startsWith('\x1b[?2026h')).toBe(true);
      expect(dataMsg.d.endsWith('\x1b[?2026l')).toBe(true);
      expect(stripSync(dataMsg.d)).toBe('hello from device');

      msgPromise = nextMessage(ws);
      sink({ kind: 'clear' });
      expect(await msgPromise).toEqual({ t: 'c' });

      msgPromise = nextMessage(ws);
      sink({ kind: 'refresh' });
      expect(await msgPromise).toEqual({ t: 'r' });
    });

    it('coalesces rapid data events into a single batched frame', async () => {
      const handle = setupOnlineDevice();
      const ws = await connectTerminal();
      await vi.waitFor(() => expect(handle.subscribeTerminal).toHaveBeenCalledTimes(1));
      const [, sink] = handle.subscribeTerminal.mock.calls[0] as [string, TerminalSink];

      const msgPromise = nextMessage(ws);
      sink({ kind: 'data', data: 'chunk1' });
      sink({ kind: 'data', data: 'chunk2' });
      sink({ kind: 'data', data: 'chunk3' });
      const msg = (await msgPromise) as { t: string; d: string };
      expect(stripSync(msg.d)).toBe('chunk1chunk2chunk3');
    });

    it('forwards {t:"i"} to handle.writeInput with all four args and ACKs with {t:"ia",seq}', async () => {
      const handle = setupOnlineDevice();
      const ws = await connectTerminal();
      await vi.waitFor(() => expect(handle.subscribeTerminal).toHaveBeenCalledTimes(1));

      const msgPromise = nextMessage(ws);
      ws.send(JSON.stringify({ t: 'i', d: 'ls -la\n', seq: 42, cid: 'cid-1' }));
      const ack = await msgPromise;
      expect(ack).toEqual({ t: 'ia', seq: 42 });
      expect(handle.writeInput).toHaveBeenCalledWith(termSessionId, 'ls -la\n', 42, 'cid-1');
    });

    it('does not ACK an {t:"i"} frame without a seq, but still forwards it', async () => {
      const handle = setupOnlineDevice();
      const ws = await connectTerminal();
      await vi.waitFor(() => expect(handle.subscribeTerminal).toHaveBeenCalledTimes(1));

      ws.send(JSON.stringify({ t: 'i', d: 'no-seq-here' }));
      await vi.waitFor(() => {
        expect(handle.writeInput).toHaveBeenCalledWith(termSessionId, 'no-seq-here', undefined, undefined);
      });
    });

    it('rejects an {t:"i"} frame longer than MAX_INPUT_LENGTH', async () => {
      const handle = setupOnlineDevice();
      const ws = await connectTerminal();
      await vi.waitFor(() => expect(handle.subscribeTerminal).toHaveBeenCalledTimes(1));

      const tooLong = 'x'.repeat(64 * 1024 + 1);
      ws.send(JSON.stringify({ t: 'i', d: tooLong, seq: 1 }));

      // Follow up with a valid frame to confirm the connection survived and only
      // the oversized one was dropped.
      ws.send(JSON.stringify({ t: 'i', d: 'ok', seq: 2 }));
      await vi.waitFor(() => expect(handle.writeInput).toHaveBeenCalledWith(termSessionId, 'ok', 2, undefined));
      expect(handle.writeInput).not.toHaveBeenCalledWith(termSessionId, tooLong, 1, undefined);
    });

    it('forwards {t:"z"} to handle.resize with mapped viewportType/force and enforces 1-500/1-200 bounds', async () => {
      const handle = setupOnlineDevice();
      const ws = await connectTerminal();
      await vi.waitFor(() => expect(handle.subscribeTerminal).toHaveBeenCalledTimes(1));

      ws.send(JSON.stringify({ t: 'z', c: 120, r: 40, f: true, v: 'desktop' }));
      await vi.waitFor(() => {
        expect(handle.resize).toHaveBeenCalledWith(termSessionId, 120, 40, { viewportType: 'desktop', force: true });
      });

      handle.resize.mockClear();
      ws.send(JSON.stringify({ t: 'z', c: 501, r: 40 }));
      ws.send(JSON.stringify({ t: 'z', c: 10, r: 0 }));
      // A subsequent valid resize proves the out-of-bounds ones above were ignored, not queued.
      ws.send(JSON.stringify({ t: 'z', c: 80, r: 24 }));
      await vi.waitFor(() =>
        expect(handle.resize).toHaveBeenCalledWith(termSessionId, 80, 24, { viewportType: undefined, force: false })
      );
      expect(handle.resize).toHaveBeenCalledTimes(1);
    });

    it("closes 4009 when the controller emits device-offline for this connection's deviceId", async () => {
      setupOnlineDevice();
      const ws = await connectTerminal();
      await vi.waitFor(() => expect(controller.getHandle).toHaveBeenCalled());

      const closePromise = waitForClose(ws);
      controller.emit('device-offline', browserDeviceId);
      const { code } = await closePromise;
      expect(code).toBe(4009);
    });

    it('ignores a device-offline event for a different deviceId', async () => {
      setupOnlineDevice();
      const ws = await connectTerminal();
      await vi.waitFor(() => expect(controller.getHandle).toHaveBeenCalled());

      controller.emit('device-offline', 'some-other-device');
      // Send a resize afterwards; if the socket had been (wrongly) closed this would throw/no-op.
      ws.send(JSON.stringify({ t: 'z', c: 80, r: 24 }));
      await vi.waitFor(() => expect(ws.readyState).toBe(WebSocket.OPEN));
    });

    it('calls the subscribeTerminal unsub and removes the device-offline listener on client disconnect', async () => {
      const handle = setupOnlineDevice();
      const ws = await connectTerminal();
      await vi.waitFor(() => expect(handle.subscribeTerminal).toHaveBeenCalledTimes(1));
      const unsub = handle.subscribeTerminal.mock.results[0].value as ReturnType<typeof vi.fn>;

      const listenersBefore = controller.listenerCount('device-offline');
      expect(listenersBefore).toBeGreaterThan(0);

      ws.close();
      await waitForClose(ws);

      await vi.waitFor(() => expect(unsub).toHaveBeenCalledTimes(1));
      expect(controller.listenerCount('device-offline')).toBe(listenersBefore - 1);
    });

    it('closes 4008 for a 7th concurrent browser terminal connection from the same IP', async () => {
      setupOnlineDevice();
      for (let i = 0; i < 6; i++) {
        await connectTerminal();
      }

      const seventh = new WebSocket(`ws://127.0.0.1:${PORT}${path}`);
      openSockets.push(seventh);
      const { code, reason } = await waitForClose(seventh);
      expect(code).toBe(4008);
      expect(reason).toBe('Too many connections');
    });
  });
});
