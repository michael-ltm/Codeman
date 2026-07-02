import { describe, it, expect, vi } from 'vitest';
import { LocalDeviceAdapter } from '../../src/fleet/device-adapter.js';
import type { LocalSessionOps } from '../../src/fleet/local-session-ops.js';
import type { FleetCapabilities, FleetSessionSummary } from '../../src/fleet/protocol.js';

function makeOps(overrides: Partial<LocalSessionOps> = {}): LocalSessionOps {
  return {
    listSessions: vi.fn(() => []),
    createSession: vi.fn(async () => ({}) as FleetSessionSummary),
    stopSession: vi.fn(async () => {}),
    writeInput: vi.fn(),
    resize: vi.fn(),
    subscribeTerminal: vi.fn(() => () => {}),
    getTerminalBuffer: vi.fn(async () => ''),
    ...overrides,
  };
}

const capabilities: FleetCapabilities = { tmux: true, claude: true, codex: false, shell: true };
const identity = { deviceId: 'dev_local', name: 'my-mac', version: '1.2.3', capabilities };

describe('LocalDeviceAdapter', () => {
  it('exposes deviceId from identity', () => {
    const adapter = new LocalDeviceAdapter(identity, makeOps());
    expect(adapter.deviceId).toBe('dev_local');
  });

  it('summary() reports online status, identity fields, host facts, and capabilities', () => {
    const adapter = new LocalDeviceAdapter(identity, makeOps());
    const s = adapter.summary();
    expect(s.id).toBe('dev_local');
    expect(s.name).toBe('my-mac');
    expect(s.version).toBe('1.2.3');
    expect(s.status).toBe('online');
    expect(s.capabilities).toEqual(capabilities);
    expect(typeof s.hostname).toBe('string');
    expect(s.hostname.length).toBeGreaterThan(0);
    expect(typeof s.platform).toBe('string');
    expect(typeof s.arch).toBe('string');
    expect(typeof s.username).toBe('string');
    expect(s.lastSeenAt).toBeGreaterThan(0);
  });

  it('summary() activeSessionCount excludes stopped sessions only', () => {
    const sessions = [
      { status: 'idle' },
      { status: 'busy' },
      { status: 'stopped' },
      { status: 'error' },
      { status: 'stopped' },
    ] as FleetSessionSummary[];
    const ops = makeOps({ listSessions: vi.fn(() => sessions) });
    const adapter = new LocalDeviceAdapter(identity, ops);
    expect(adapter.summary().activeSessionCount).toBe(3);
  });

  it('listSessions delegates to ops.listSessions and resolves to the same array', async () => {
    const list = [{ id: 's1' }] as FleetSessionSummary[];
    const ops = makeOps({ listSessions: vi.fn(() => list) });
    const adapter = new LocalDeviceAdapter(identity, ops);
    await expect(adapter.listSessions()).resolves.toBe(list);
    expect(ops.listSessions).toHaveBeenCalled();
  });

  it('createSession delegates to ops.createSession with the same input', async () => {
    const input = { workingDir: '/tmp', mode: 'claude' as const };
    const summary = { id: 's1' } as FleetSessionSummary;
    const ops = makeOps({ createSession: vi.fn(async () => summary) });
    const adapter = new LocalDeviceAdapter(identity, ops);
    await expect(adapter.createSession(input)).resolves.toBe(summary);
    expect(ops.createSession).toHaveBeenCalledWith(input);
  });

  it('stopSession delegates to ops.stopSession', async () => {
    const ops = makeOps();
    const adapter = new LocalDeviceAdapter(identity, ops);
    await adapter.stopSession('s1');
    expect(ops.stopSession).toHaveBeenCalledWith('s1');
  });

  it('writeInput delegates to ops.writeInput with all args', () => {
    const ops = makeOps();
    const adapter = new LocalDeviceAdapter(identity, ops);
    adapter.writeInput('s1', 'hi', 3, 'cid1');
    expect(ops.writeInput).toHaveBeenCalledWith('s1', 'hi', 3, 'cid1');
  });

  it('resize delegates to ops.resize with opts', () => {
    const ops = makeOps();
    const adapter = new LocalDeviceAdapter(identity, ops);
    adapter.resize('s1', 80, 24, { viewportType: 'desktop', force: true });
    expect(ops.resize).toHaveBeenCalledWith('s1', 80, 24, { viewportType: 'desktop', force: true });
  });

  it('subscribeTerminal delegates and returns the unsubscribe fn from ops', () => {
    const unsub = vi.fn();
    const ops = makeOps({ subscribeTerminal: vi.fn(() => unsub) });
    const adapter = new LocalDeviceAdapter(identity, ops);
    const sink = vi.fn();
    const result = adapter.subscribeTerminal('s1', sink);
    expect(ops.subscribeTerminal).toHaveBeenCalledWith('s1', sink);
    expect(result).toBe(unsub);
  });

  it('getTerminalBuffer delegates to ops.getTerminalBuffer', async () => {
    const ops = makeOps({ getTerminalBuffer: vi.fn(async () => 'buffer-content') });
    const adapter = new LocalDeviceAdapter(identity, ops);
    await expect(adapter.getTerminalBuffer('s1')).resolves.toBe('buffer-content');
    expect(ops.getTerminalBuffer).toHaveBeenCalledWith('s1');
  });
});
