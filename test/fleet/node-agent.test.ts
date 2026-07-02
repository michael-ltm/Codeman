/**
 * @fileoverview Tests for FleetNodeAgent (src/fleet/node-agent.ts).
 *
 * A real listening Fastify + @fastify/websocket server on a free port plays the
 * "central controller": it accepts the node WS connection at `/ws/fleet/node`,
 * captures the request headers (to assert the agent sends the Bearer token +
 * device-id header), records every frame the agent sends, and can push frames
 * back down to the agent. `LocalSessionOps` is fully mocked with vi.fn().
 *
 * heartbeat / reconnect intervals are shortened via constructor opts so the
 * reconnect-backoff and stop() cases run in well under a second.
 *
 * Port: 3172
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import type { WebSocket as WsWebSocket } from 'ws';
import type { IncomingHttpHeaders } from 'node:http';
import { FleetNodeAgent } from '../../src/fleet/node-agent.js';
import type { LocalSessionOps, TerminalSink } from '../../src/fleet/local-session-ops.js';
import type {
  CentralToNodeFrame,
  FleetDeviceSummary,
  FleetSessionSummary,
  NodeToCentralFrame,
} from '../../src/fleet/protocol.js';
import type { FleetNodeConfig } from '../../src/fleet/node-config.js';

const PORT = 3172;
const TOKEN = 'test-token-abc';
const DEVICE_ID = 'dev_local_test';

const device: FleetDeviceSummary = {
  id: DEVICE_ID,
  name: 'node-under-test',
  hostname: 'node.local',
  platform: 'linux',
  arch: 'x64',
  username: 'runner',
  version: '9.9.9',
  status: 'online',
  lastSeenAt: 0,
  activeSessionCount: 0,
  capabilities: { tmux: true, claude: true, codex: false, shell: true },
};

const config: FleetNodeConfig = {
  centralUrl: `http://127.0.0.1:${PORT}`,
  deviceId: DEVICE_ID,
  token: TOKEN,
  deviceName: 'node-under-test',
  joinedAt: 0,
};

function makeSession(overrides: Partial<FleetSessionSummary> = {}): FleetSessionSummary {
  return {
    deviceId: DEVICE_ID,
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

interface MockOps extends LocalSessionOps {
  __sinks: Map<string, TerminalSink>;
}

function makeOps(): MockOps {
  const sinks = new Map<string, TerminalSink>();
  const ops = {
    listSessions: vi.fn<() => FleetSessionSummary[]>(() => []),
    createSession: vi.fn(async (input) => makeSession({ id: 'created', workingDir: input.workingDir })),
    stopSession: vi.fn(async () => {}),
    writeInput: vi.fn(),
    resize: vi.fn(),
    subscribeTerminal: vi.fn((sessionId: string, sink: TerminalSink) => {
      sinks.set(sessionId, sink);
      return () => sinks.delete(sessionId);
    }),
    getTerminalBuffer: vi.fn(async () => 'BUFFER'),
    __sinks: sinks,
  };
  return ops as unknown as MockOps;
}

// ---- fake central controller (real Fastify WS server) ----

interface Central {
  app: FastifyInstance;
  received: NodeToCentralFrame[];
  lastHeaders: IncomingHttpHeaders | null;
  serverSocket: WsWebSocket | null;
  connectionCount: number;
}

async function startCentral(): Promise<Central> {
  const app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);
  const central: Central = {
    app,
    received: [],
    lastHeaders: null,
    serverSocket: null,
    connectionCount: 0,
  };
  app.get('/ws/fleet/node', { websocket: true }, (socket: WsWebSocket, req) => {
    central.lastHeaders = req.headers;
    central.serverSocket = socket;
    central.connectionCount += 1;
    socket.on('error', () => {});
    socket.on('message', (raw: unknown) => {
      try {
        central.received.push(JSON.parse(String(raw)) as NodeToCentralFrame);
      } catch {
        /* ignore non-JSON */
      }
    });
  });
  await app.listen({ port: PORT, host: '127.0.0.1' });
  return central;
}

function sendToAgent(central: Central, frame: CentralToNodeFrame): void {
  central.serverSocket?.send(JSON.stringify(frame));
}

async function waitFor(fn: () => void, timeout = 3000): Promise<void> {
  await vi.waitFor(fn, { timeout, interval: 10 });
}

function framesOfType<T extends NodeToCentralFrame['t']>(
  central: Central,
  t: T
): Extract<NodeToCentralFrame, { t: T }>[] {
  return central.received.filter((f) => f.t === t) as Extract<NodeToCentralFrame, { t: T }>[];
}

describe('FleetNodeAgent', () => {
  let central: Central;
  let ops: MockOps;
  let agent: FleetNodeAgent | null;

  beforeEach(async () => {
    central = await startCentral();
    ops = makeOps();
    agent = null;
  });

  afterEach(async () => {
    agent?.stop();
    agent = null;
    await central.app.close();
  });

  function newAgent(): FleetNodeAgent {
    return new FleetNodeAgent({
      config,
      ops,
      device,
      heartbeatMs: 10_000,
      reconnectBaseMs: 40,
      reconnectMaxMs: 200,
    });
  }

  // 1. hello + Bearer header
  it('sends a valid hello (with Bearer + device-id headers) after connecting', async () => {
    agent = newAgent();
    agent.start();

    await waitFor(() => expect(framesOfType(central, 'hello').length).toBeGreaterThan(0), 5000);

    expect(central.lastHeaders?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(central.lastHeaders?.['x-codeman-device-id']).toBe(DEVICE_ID);

    const hello = framesOfType(central, 'hello')[0];
    expect(hello.protocol).toBe(1);
    expect(hello.device.id).toBe(DEVICE_ID);
    expect(Array.isArray(hello.sessions)).toBe(true);
    expect(ops.listSessions).toHaveBeenCalled();
  });

  // 2. create-session -> ack with ops result
  it('replies with an ack carrying ops.createSession result', async () => {
    agent = newAgent();
    agent.start();
    await waitFor(() => expect(central.serverSocket).not.toBeNull());

    sendToAgent(central, { t: 'create-session', requestId: 'req-1', payload: { workingDir: '/work' } });

    await waitFor(() => expect(framesOfType(central, 'ack').some((f) => f.requestId === 'req-1')).toBe(true));
    const ack = framesOfType(central, 'ack').find((f) => f.requestId === 'req-1')!;
    expect(ops.createSession).toHaveBeenCalledWith({ workingDir: '/work' });
    expect(ack.data).toMatchObject({ id: 'created', workingDir: '/work' });
  });

  // 3. create-session throws -> error{requestId, message}
  it('replies with an error frame when ops.createSession throws', async () => {
    ops.createSession = vi.fn(async () => {
      throw new Error('boom-create');
    }) as unknown as MockOps['createSession'];
    agent = newAgent();
    agent.start();
    await waitFor(() => expect(central.serverSocket).not.toBeNull());

    sendToAgent(central, { t: 'create-session', requestId: 'req-err', payload: { workingDir: '/work' } });

    await waitFor(() => expect(framesOfType(central, 'error').some((f) => f.requestId === 'req-err')).toBe(true));
    const err = framesOfType(central, 'error').find((f) => f.requestId === 'req-err')!;
    expect(err.message).toContain('boom-create');
  });

  // 4. terminal:subscribe -> sink data -> terminal:data on the wire (+ idempotent)
  it('subscribes and forwards sink data as terminal:data (subscribe is idempotent)', async () => {
    agent = newAgent();
    agent.start();
    await waitFor(() => expect(central.serverSocket).not.toBeNull());

    sendToAgent(central, { t: 'terminal:subscribe', requestId: 'sub-1', sessionId: 's1' });
    await waitFor(() => expect(framesOfType(central, 'ack').some((f) => f.requestId === 'sub-1')).toBe(true));

    // Re-subscribe must be idempotent: another ack, but no second ops listener.
    sendToAgent(central, { t: 'terminal:subscribe', requestId: 'sub-2', sessionId: 's1' });
    await waitFor(() => expect(framesOfType(central, 'ack').some((f) => f.requestId === 'sub-2')).toBe(true));
    expect(ops.subscribeTerminal).toHaveBeenCalledTimes(1);

    const sink = ops.__sinks.get('s1')!;
    expect(sink).toBeTruthy();
    sink({ kind: 'data', data: 'hello-term' });

    await waitFor(() => expect(framesOfType(central, 'terminal:data').length).toBeGreaterThan(0));
    const dataFrame = framesOfType(central, 'terminal:data')[0];
    expect(dataFrame.sessionId).toBe('s1');
    expect(dataFrame.data).toBe('hello-term');
  });

  // 5. terminal:input -> ops.writeInput(sessionId, data, seq, cid)
  it('routes terminal:input to ops.writeInput with seq/cid', async () => {
    agent = newAgent();
    agent.start();
    await waitFor(() => expect(central.serverSocket).not.toBeNull());

    sendToAgent(central, { t: 'terminal:input', sessionId: 's7', data: 'ls\n', seq: 5, cid: 'c9' });

    await waitFor(() => expect(ops.writeInput).toHaveBeenCalledWith('s7', 'ls\n', 5, 'c9'));
  });

  // 6. server disconnects -> agent reconnects
  it('reconnects after the central drops the connection', async () => {
    agent = newAgent();
    agent.start();
    await waitFor(() => expect(central.connectionCount).toBe(1));

    central.serverSocket?.close();

    await waitFor(() => expect(central.connectionCount).toBe(2), 3000);
    // second connection also sends a hello
    await waitFor(() => expect(framesOfType(central, 'hello').length).toBeGreaterThanOrEqual(2));
  });

  // 7. stop() -> no reconnect
  it('does not reconnect after stop()', async () => {
    agent = newAgent();
    agent.start();
    await waitFor(() => expect(central.connectionCount).toBe(1));

    agent.stop();

    // Give it well past reconnectBaseMs (40ms) to prove no new connection is made.
    await new Promise((r) => setTimeout(r, 300));
    expect(central.connectionCount).toBe(1);
  });

  // subscription cleanup on socket close
  it('unsubscribes all terminal sinks when the socket closes', async () => {
    const unsub = vi.fn();
    ops.subscribeTerminal = vi.fn((sessionId: string, sink: TerminalSink) => {
      ops.__sinks.set(sessionId, sink);
      return unsub;
    }) as unknown as MockOps['subscribeTerminal'];

    agent = newAgent();
    agent.start();
    await waitFor(() => expect(central.serverSocket).not.toBeNull());

    sendToAgent(central, { t: 'terminal:subscribe', requestId: 'sub-x', sessionId: 's1' });
    await waitFor(() => expect(ops.subscribeTerminal).toHaveBeenCalledTimes(1));

    central.serverSocket?.close();
    await waitFor(() => expect(unsub).toHaveBeenCalledTimes(1));
  });
});
