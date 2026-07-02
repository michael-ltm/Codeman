import { describe, it, expect, vi } from 'vitest';
import { createMockRouteContext } from '../mocks/mock-route-context.js';
import { createLocalSessionOps, sessionStatusForFleet } from '../../src/fleet/local-session-ops.js';
import type { Session } from '../../src/session.js';

describe('LocalSessionOps', () => {
  it('lists sessions as FleetSessionSummary with deviceId stamped', () => {
    const ctx = createMockRouteContext(); // 含 _session(见 mock 实现)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ops = createLocalSessionOps('dev_local', ctx as any);
    const list = ops.listSessions();
    expect(list.every((s) => s.deviceId === 'dev_local')).toBe(true);
    expect(list.length).toBe(1);
    const [summary] = list;
    expect(summary.id).toBe(ctx._session.id);
    expect(summary.mode).toBe(ctx._session.mode);
    expect(summary.workingDir).toBe(ctx._session.workingDir);
    expect(summary.pid).toBe(ctx._session.pid);
    expect(summary.status).toBe('idle');
  });

  it('writeInput applies shouldApplyInput dedup', () => {
    const ctx = createMockRouteContext();
    const s = ctx._session; // mock session
    s.shouldApplyInput = vi.fn(() => false);
    s.write = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createLocalSessionOps('d', ctx as any).writeInput(s.id, 'x', 1, 'c1');
    expect(s.write).not.toHaveBeenCalled();
    expect(s.shouldApplyInput).toHaveBeenCalledWith('c1', 1);
  });

  it('writeInput writes through when dedup allows it, and when no seq/cid given', () => {
    const ctx = createMockRouteContext();
    const s = ctx._session;
    s.shouldApplyInput = vi.fn(() => true);
    s.write = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ops = createLocalSessionOps('d', ctx as any);
    ops.writeInput(s.id, 'x', 1, 'c1');
    expect(s.write).toHaveBeenCalledWith('x');

    (s.write as ReturnType<typeof vi.fn>).mockClear();
    ops.writeInput(s.id, 'y'); // no seq/cid -> always applied, dedup not consulted
    expect(s.write).toHaveBeenCalledWith('y');
  });

  it('subscribeTerminal forwards terminal/clear/refresh and unsubscribes cleanly', () => {
    const ctx = createMockRouteContext();
    const s = ctx._session;
    const events: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const unsub = createLocalSessionOps('d', ctx as any).subscribeTerminal(s.id, (ev) => events.push(ev.kind));
    s.emit('terminal', 'abc');
    s.emit('clearTerminal');
    s.emit('needsRefresh');
    expect(events).toEqual(['data', 'clear', 'refresh']);
    unsub();
    s.emit('terminal', 'zzz');
    expect(events.length).toBe(3);
  });

  it('subscribeTerminal data event carries the terminal payload', () => {
    const ctx = createMockRouteContext();
    const s = ctx._session;
    const events: unknown[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createLocalSessionOps('d', ctx as any).subscribeTerminal(s.id, (ev) => events.push(ev));
    s.emit('terminal', 'hello');
    expect(events).toEqual([{ kind: 'data', data: 'hello' }]);
  });

  it('unknown session id throws Session not found', () => {
    const ctx = createMockRouteContext();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => createLocalSessionOps('d', ctx as any).writeInput('nope', 'x')).toThrow(/session not found/i);
  });

  it('resize forwards to session.resize with cols/rows/opts', () => {
    const ctx = createMockRouteContext();
    const s = ctx._session;
    s.resize = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createLocalSessionOps('d', ctx as any).resize(s.id, 80, 24, { viewportType: 'desktop', force: true });
    expect(s.resize).toHaveBeenCalledWith(80, 24, { viewportType: 'desktop', force: true });
  });

  it('resize on unknown session id throws Session not found', () => {
    const ctx = createMockRouteContext();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => createLocalSessionOps('d', ctx as any).resize('nope', 80, 24)).toThrow(/session not found/i);
  });

  it('getTerminalBuffer resolves the buffer text for a known session', async () => {
    const ctx = createMockRouteContext();
    const s = ctx._session;
    s.terminalBuffer = 'hello from mock terminal';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer = await createLocalSessionOps('d', ctx as any).getTerminalBuffer(s.id);
    expect(buffer).toContain('hello from mock terminal');
  });

  it('getTerminalBuffer on unknown session id rejects', async () => {
    const ctx = createMockRouteContext();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(createLocalSessionOps('d', ctx as any).getTerminalBuffer('nope')).rejects.toThrow(/not found/i);
  });

  it('stopSession delegates to the shared cleanup path (deleteSessionCore)', async () => {
    const ctx = createMockRouteContext();
    const s = ctx._session;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createLocalSessionOps('d', ctx as any).stopSession(s.id);
    expect(ctx.cleanupSession).toHaveBeenCalledWith(s.id, true, 'user_delete');
  });

  it('stopSession on unknown session id rejects with NOT_FOUND', async () => {
    const ctx = createMockRouteContext();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(createLocalSessionOps('d', ctx as any).stopSession('nope')).rejects.toThrow(/not found/i);
  });

  it('createSession rejects an unknown mode before touching the session core', async () => {
    const ctx = createMockRouteContext();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ops = createLocalSessionOps('d', ctx as any);
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ops.createSession({ workingDir: '/tmp', mode: 'bogus' as any })
    ).rejects.toThrow(/unknown mode/i);
    expect(ctx.addSession).not.toHaveBeenCalled();
  });

  describe('sessionStatusForFleet', () => {
    const fakeSession = (status: string) => ({ status }) as unknown as Session;

    it('maps idle/busy/stopped/error 1:1', () => {
      expect(sessionStatusForFleet(fakeSession('idle'))).toBe('idle');
      expect(sessionStatusForFleet(fakeSession('busy'))).toBe('busy');
      expect(sessionStatusForFleet(fakeSession('stopped'))).toBe('stopped');
      expect(sessionStatusForFleet(fakeSession('error'))).toBe('error');
    });

    it('falls back to idle for unknown values', () => {
      expect(sessionStatusForFleet(fakeSession('something-unexpected'))).toBe('idle');
    });
  });
});
