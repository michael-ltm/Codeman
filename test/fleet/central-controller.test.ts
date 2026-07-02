import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FleetCentralController, type NodeSocketLike } from '../../src/fleet/central-controller.js';
import { DeviceRegistry } from '../../src/fleet/device-registry.js';
import type { FleetDeviceHandle } from '../../src/fleet/device-adapter.js';
import type {
  CreateFleetSessionRequest,
  FleetCapabilities,
  FleetSessionSummary,
  NodeToCentralFrame,
} from '../../src/fleet/protocol.js';
import type { TerminalSink } from '../../src/fleet/local-session-ops.js';

const capabilities: FleetCapabilities = { tmux: true, claude: true, codex: false, shell: true };

function makeRegistry(): DeviceRegistry {
  const file = join(mkdtempSync(join(tmpdir(), 'fleet-ctrl-')), 'fleet-devices.json');
  return new DeviceRegistry(file);
}

/** Registers a device via the real pairing flow so registry.listDevices()/getDevice() know about it. */
function pairDevice(reg: DeviceRegistry, name = 'node-1'): string {
  const { code } = reg.createPairingCode();
  const { deviceId } = reg.consumePairingCode(code, {
    name,
    hostname: `${name}.local`,
    platform: 'linux',
    arch: 'x64',
    username: 'runner',
    version: '1.0.0',
    capabilities,
  });
  return deviceId;
}

function makeSocket(): NodeSocketLike & { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
  return { send: vi.fn(), close: vi.fn() };
}

/** Parses every JSON frame sent through the fake socket, optionally filtered by frame `t`. */
function framesSent(socket: { send: ReturnType<typeof vi.fn> }, type?: string): Array<Record<string, unknown>> {
  const frames = socket.send.mock.calls.map(([raw]: [string]) => JSON.parse(raw) as Record<string, unknown>);
  return type ? frames.filter((f) => f.t === type) : frames;
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

function makeLocalHandle(overrides: Partial<FleetDeviceHandle> = {}): FleetDeviceHandle {
  return {
    deviceId: 'dev_local',
    summary: vi.fn(() => ({
      id: 'dev_local',
      name: 'local-mac',
      hostname: 'local-mac.local',
      platform: 'darwin',
      arch: 'arm64',
      username: 'ming',
      version: '1.2.3',
      status: 'online',
      lastSeenAt: Date.now(),
      activeSessionCount: 0,
      capabilities,
    })),
    listSessions: vi.fn(async () => []),
    createSession: vi.fn(async () => makeSession()),
    stopSession: vi.fn(async () => {}),
    writeInput: vi.fn(),
    resize: vi.fn(),
    subscribeTerminal: vi.fn(() => () => {}),
    getTerminalBuffer: vi.fn(async () => ''),
    ...overrides,
  };
}

describe('FleetCentralController', () => {
  it('1. connectNode marks device online, seeds session cache, and broadcasts fleet:device-online', async () => {
    const reg = makeRegistry();
    const deviceId = pairDevice(reg);
    const controller = new FleetCentralController(reg);
    const onBroadcast = vi.fn();
    controller.on('broadcast', onBroadcast);
    const socket = makeSocket();
    const session = makeSession({ deviceId, id: 'sess-1' });

    controller.connectNode(deviceId, socket, helloFrame(deviceId, [session]));

    expect(controller.isOnline(deviceId)).toBe(true);
    const state = await controller.getDashboardState();
    expect(state.devices.find((d) => d.id === deviceId)?.status).toBe('online');
    expect(state.sessions).toContainEqual(session);
    expect(onBroadcast).toHaveBeenCalledWith(
      'fleet:device-online',
      expect.objectContaining({ id: deviceId, status: 'online' })
    );
  });

  it('2. createSession sends a create-session frame; ack resolves the returned promise', async () => {
    const reg = makeRegistry();
    const deviceId = pairDevice(reg);
    const controller = new FleetCentralController(reg);
    const socket = makeSocket();
    controller.connectNode(deviceId, socket, helloFrame(deviceId));
    const handle = controller.getHandle(deviceId)!;

    const input: CreateFleetSessionRequest = { workingDir: '/proj' };
    const promise = handle.createSession(input);

    const sent = framesSent(socket, 'create-session');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ payload: input });
    expect(typeof sent[0].requestId).toBe('string');

    const created = makeSession({ deviceId, id: 'sess-new' });
    controller.handleNodeFrame(deviceId, { t: 'ack', requestId: sent[0].requestId as string, data: created });

    await expect(promise).resolves.toEqual(created);
  });

  it('3. error frame rejects with its message; no ack within 10s rejects with a timeout error', async () => {
    vi.useFakeTimers();
    try {
      const reg = makeRegistry();
      const deviceId = pairDevice(reg);
      const controller = new FleetCentralController(reg);
      const socket = makeSocket();
      controller.connectNode(deviceId, socket, helloFrame(deviceId));
      const handle = controller.getHandle(deviceId)!;

      const p1 = handle.stopSession('sess-1');
      const sent1 = framesSent(socket, 'stop-session');
      controller.handleNodeFrame(deviceId, { t: 'error', requestId: sent1[0].requestId as string, message: 'boom' });
      await expect(p1).rejects.toThrow('boom');

      const p2 = handle.stopSession('sess-2');
      const expectation = expect(p2).rejects.toThrow('Fleet node request timed out');
      await vi.advanceTimersByTimeAsync(10_000);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it('4. subscribeTerminal ref-counts subscribe/unsubscribe RPCs and fans out terminal:data to every sink', () => {
    const reg = makeRegistry();
    const deviceId = pairDevice(reg);
    const controller = new FleetCentralController(reg);
    const socket = makeSocket();
    controller.connectNode(deviceId, socket, helloFrame(deviceId));
    const handle = controller.getHandle(deviceId)!;

    const sinkA: TerminalSink = vi.fn();
    const sinkB: TerminalSink = vi.fn();
    const unsubA = handle.subscribeTerminal('sess-1', sinkA);
    const unsubB = handle.subscribeTerminal('sess-1', sinkB);

    const subscribeCalls = framesSent(socket, 'terminal:subscribe');
    expect(subscribeCalls).toHaveLength(1);
    controller.handleNodeFrame(deviceId, { t: 'ack', requestId: subscribeCalls[0].requestId as string });

    controller.handleNodeFrame(deviceId, { t: 'terminal:data', sessionId: 'sess-1', data: 'hi' });
    expect(sinkA).toHaveBeenCalledWith({ kind: 'data', data: 'hi' });
    expect(sinkB).toHaveBeenCalledWith({ kind: 'data', data: 'hi' });

    unsubA();
    expect(framesSent(socket, 'terminal:unsubscribe')).toHaveLength(0);

    unsubB();
    const unsubscribeCalls = framesSent(socket, 'terminal:unsubscribe');
    expect(unsubscribeCalls).toHaveLength(1);
    controller.handleNodeFrame(deviceId, { t: 'ack', requestId: unsubscribeCalls[0].requestId as string });
  });

  it('5. disconnectNode rejects pending requests, marks offline, and emits offline events', async () => {
    const reg = makeRegistry();
    const deviceId = pairDevice(reg);
    const controller = new FleetCentralController(reg);
    const onBroadcast = vi.fn();
    const onDeviceOffline = vi.fn();
    controller.on('broadcast', onBroadcast);
    controller.on('device-offline', onDeviceOffline);
    const socket = makeSocket();
    controller.connectNode(deviceId, socket, helloFrame(deviceId));
    const handle = controller.getHandle(deviceId)!;

    const pending = handle.stopSession('sess-1');
    const rejection = expect(pending).rejects.toThrow('Device disconnected');

    controller.disconnectNode(deviceId);

    await rejection;
    expect(controller.isOnline(deviceId)).toBe(false);
    expect(onBroadcast).toHaveBeenCalledWith('fleet:device-offline', { deviceId });
    expect(onDeviceOffline).toHaveBeenCalledWith(deviceId);
  });

  it('6. heartbeat updates the session cache and only broadcasts on change; session:update always broadcasts', async () => {
    const reg = makeRegistry();
    const deviceId = pairDevice(reg);
    const controller = new FleetCentralController(reg);
    const socket = makeSocket();
    const initial = makeSession({ deviceId, id: 'sess-1', status: 'idle' });
    controller.connectNode(deviceId, socket, helloFrame(deviceId, [initial]));
    const onBroadcast = vi.fn();
    controller.on('broadcast', onBroadcast);

    // Identical session list -> no sessions-updated broadcast.
    controller.handleNodeFrame(deviceId, { t: 'heartbeat', sessions: [initial] });
    expect(onBroadcast).not.toHaveBeenCalledWith('fleet:sessions-updated', expect.anything());

    // Changed session list -> broadcast, and cache reflects the update.
    const busy = { ...initial, status: 'busy' as const };
    controller.handleNodeFrame(deviceId, { t: 'heartbeat', sessions: [busy] });
    expect(onBroadcast).toHaveBeenCalledWith('fleet:sessions-updated', { deviceId, sessions: [busy] });
    const state = await controller.getDashboardState();
    expect(state.sessions.find((s) => s.id === 'sess-1')?.status).toBe('busy');

    onBroadcast.mockClear();
    controller.handleNodeFrame(deviceId, { t: 'session:update', session: busy });
    expect(onBroadcast).toHaveBeenCalledWith('fleet:sessions-updated', { deviceId, sessions: [busy] });
  });

  it('7. registerLocalDevice merges the local device into getDashboardState, activeSessionCount from handle.summary()', async () => {
    const reg = makeRegistry();
    const controller = new FleetCentralController(reg);
    const localHandle = makeLocalHandle({
      summary: vi.fn(() => ({
        id: 'dev_local',
        name: 'local-mac',
        hostname: 'local-mac.local',
        platform: 'darwin',
        arch: 'arm64',
        username: 'ming',
        version: '1.2.3',
        status: 'online',
        lastSeenAt: 5000,
        activeSessionCount: 2,
        capabilities,
      })),
      listSessions: vi.fn(async () => [makeSession({ deviceId: 'dev_local', id: 'l1' })]),
    });

    controller.registerLocalDevice(localHandle);

    const state = await controller.getDashboardState();
    const found = state.devices.find((d) => d.id === 'dev_local');
    expect(found?.activeSessionCount).toBe(2);
    expect(state.sessions.some((s) => s.id === 'l1')).toBe(true);
    expect(controller.isOnline('dev_local')).toBe(true);
    expect(controller.getHandle('dev_local')).toBe(localHandle);
  });

  it('8. sorts online devices before offline devices in getDashboardState', async () => {
    const reg = makeRegistry();
    const onlineDeviceId = pairDevice(reg, 'node-online');
    const offlineDeviceId = pairDevice(reg, 'node-offline');
    const controller = new FleetCentralController(reg);
    const socket = makeSocket();
    controller.connectNode(onlineDeviceId, socket, helloFrame(onlineDeviceId));
    // offlineDeviceId was paired but never connected -> stays offline in the registry.

    const state = await controller.getDashboardState();
    const ids = state.devices.map((d) => d.id);
    expect(ids.indexOf(onlineDeviceId)).toBeLessThan(ids.indexOf(offlineDeviceId));
    expect(state.devices.find((d) => d.id === offlineDeviceId)?.status).toBe('offline');
  });

  it('9. disconnectNode(id, socket) is a no-op when socket is a stale/replaced connection; the current socket still disconnects normally', async () => {
    const reg = makeRegistry();
    const deviceId = pairDevice(reg);
    const controller = new FleetCentralController(reg);
    const onBroadcast = vi.fn();
    const onDeviceOffline = vi.fn();
    controller.on('broadcast', onBroadcast);
    controller.on('device-offline', onDeviceOffline);

    const sock1 = makeSocket();
    controller.connectNode(deviceId, sock1, helloFrame(deviceId));

    // Reconnect: connectNode closes sock1 (4000, 'replaced') and installs sock2 as the live handle.
    const sock2 = makeSocket();
    controller.connectNode(deviceId, sock2, helloFrame(deviceId));
    expect(sock1.close).toHaveBeenCalledWith(4000, 'replaced');

    onBroadcast.mockClear();
    onDeviceOffline.mockClear();

    // sock1's 'close' event fires asynchronously after replacement; the WS route calls
    // disconnectNode(id, sock1) — this must be a no-op since sock1 is no longer current.
    controller.disconnectNode(deviceId, sock1);

    expect(controller.isOnline(deviceId)).toBe(true);
    expect(controller.getHandle(deviceId)).not.toBeNull();
    expect(onBroadcast).not.toHaveBeenCalledWith('fleet:device-offline', expect.anything());
    expect(onDeviceOffline).not.toHaveBeenCalled();

    // A real close of the current socket still disconnects as normal.
    controller.disconnectNode(deviceId, sock2);
    expect(controller.isOnline(deviceId)).toBe(false);
    expect(onBroadcast).toHaveBeenCalledWith('fleet:device-offline', { deviceId });
    expect(onDeviceOffline).toHaveBeenCalledWith(deviceId);
  });
});
