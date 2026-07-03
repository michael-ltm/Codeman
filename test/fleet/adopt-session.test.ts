/**
 * @fileoverview Task 28 — adopting a FOREIGN (user-owned) tmux session as a
 * first-class, DETACH-ONLY fleet session (Rev5 §13.2).
 *
 * Covers the two safety-critical layers:
 *  - `Session` in `externalHost` mode: right attach argv, adopted flag, no mux
 *    ownership, and — the red line — `stop()` NEVER calls `mux.killSession` and
 *    the attach is never a `mux.createSession`.
 *  - `adoptSessionCore` / `buildAdoptedSession`: candidate→session mapping,
 *    registration + SessionCreated broadcast, candidate-gone rejection, and
 *    `deleteSessionCore` translating an adopted delete into a detach (killMux
 *    forced false → cleanupSession never kills the foreign session).
 *
 * TmuxManager no-ops under VITEST and no PTY is spawned (we never start a real
 * externalHost session), so this is side-effect-free.
 */
import { describe, it, expect, vi } from 'vitest';
import { Session, buildExternalAttachArgs } from '../../src/session.js';
import { createMockRouteContext } from '../mocks/mock-route-context.js';
import { adoptSessionCore, buildAdoptedSession } from '../../src/fleet/adopt-session.js';
import { deleteSessionCore } from '../../src/web/route-helpers.js';
import type { ExternalSessionCandidate } from '../../src/fleet/protocol.js';

function candidate(overrides: Partial<ExternalSessionCandidate> = {}): ExternalSessionCandidate {
  return {
    socket: '',
    tmuxSession: 'work',
    mode: 'codex',
    workingDir: '/home/ming/proj',
    firstSeenAt: 111,
    ...overrides,
  };
}

describe('buildExternalAttachArgs', () => {
  it('targets the default tmux server (no -L) when socket is empty', () => {
    expect(buildExternalAttachArgs('', 'work')).toEqual(['attach-session', '-t', 'work']);
  });

  it('targets a named socket with -L when socket is set', () => {
    expect(buildExternalAttachArgs('mysock', 'work')).toEqual(['-L', 'mysock', 'attach-session', '-t', 'work']);
  });

  it('keeps the session name as a single argv element (no shell)', () => {
    // A hostile session name is passed verbatim as one arg — never interpolated.
    expect(buildExternalAttachArgs('', 'a; rm -rf ~')).toEqual(['attach-session', '-t', 'a; rm -rf ~']);
  });
});

describe('adopted Session (externalHost mode)', () => {
  it('is flagged adopted, owns no mux name, and reports the mapped fields', () => {
    const s = buildAdoptedSession(candidate({ tmuxSession: 'foo', mode: 'claude', workingDir: '/w' }));
    expect(s.isAdopted).toBe(true);
    expect(s.name).toBe('tmux:foo');
    expect(s.mode).toBe('claude');
    expect(s.workingDir).toBe('/w');
    expect(s.muxName).toBeNull(); // no Codeman mux session — nothing killable resolves
    expect(s.toState().adopted).toBe(true);
  });

  it('stop() NEVER calls mux.killSession and never created a mux session', async () => {
    const mux = {
      isAvailable: vi.fn(() => true),
      createSession: vi.fn(),
      killSession: vi.fn(async () => true),
    };
    const s = new Session({
      workingDir: '/tmp',
      mode: 'codex',
      name: 'tmux:foo',
      externalHost: { socket: '', tmuxSession: 'foo' },
      // A mux is deliberately supplied to prove the guard holds even if present.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mux: mux as any,
      useMux: false,
    });

    // A full kill (killMux=true) must still be detach-only for an adopted session.
    await s.stop(true);
    expect(mux.killSession).not.toHaveBeenCalled();
    expect(mux.createSession).not.toHaveBeenCalled();
  });

  it('a non-adopted session with a mux DOES route stop() into mux.killSession (control)', async () => {
    const mux = {
      isAvailable: vi.fn(() => true),
      createSession: vi.fn(),
      killSession: vi.fn(async () => true),
    };
    const s = new Session({
      workingDir: '/tmp',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mux: mux as any,
      useMux: true,
    });
    await s.stop(true);
    expect(mux.killSession).toHaveBeenCalledTimes(1);
  });
});

describe('adoptSessionCore', () => {
  it('registers the session, broadcasts SessionCreated, and starts the attach', async () => {
    const ctx = createMockRouteContext();
    const startInteractive = vi.fn(async () => {});
    const fake = {
      id: 'adopted-1',
      name: 'tmux:work',
      mode: 'codex',
      workingDir: '/home/ming/proj',
      isAdopted: true,
      startInteractive,
      toState: () => ({ id: 'adopted-1', adopted: true }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = await adoptSessionCore(ctx as any, candidate(), { buildSession: () => fake });

    expect(session).toBe(fake);
    expect(ctx.addSession).toHaveBeenCalledWith(fake);
    expect(ctx.sessions.get('adopted-1')).toBe(fake);
    expect(ctx.setupSessionListeners).toHaveBeenCalledWith(fake);
    expect(startInteractive).toHaveBeenCalledTimes(1);
    const created = ctx.broadcast.mock.calls.find(([ev]) => ev === 'session:created');
    expect(created).toBeTruthy();
  });

  it('throws NOT_FOUND (404) and never builds a session when the candidate has vanished', async () => {
    const ctx = createMockRouteContext();
    const buildSession = vi.fn();
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adoptSessionCore(ctx as any, candidate(), { listCandidates: () => [], buildSession })
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(buildSession).not.toHaveBeenCalled();
    expect(ctx.addSession).not.toHaveBeenCalled();
  });

  it('accepts the candidate when it is still present in the scanner cache', async () => {
    const ctx = createMockRouteContext();
    const c = candidate({ socket: 'sk', tmuxSession: 'keep' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fake = {
      id: 'a2',
      name: 'tmux:keep',
      mode: 'codex',
      startInteractive: vi.fn(async () => {}),
      toState: () => ({}),
    } as any;
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adoptSessionCore(ctx as any, c, { listCandidates: () => [c], buildSession: () => fake })
    ).resolves.toBe(fake);
  });
});

describe('deleteSessionCore — adopted delete is detach-only', () => {
  it('forces killMux=false so cleanupSession never kills the foreign session', async () => {
    const ctx = createMockRouteContext();
    const adopted = buildAdoptedSession(candidate({ tmuxSession: 'foo' }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ctx.sessions as Map<string, any>).set(adopted.id, adopted);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await deleteSessionCore(ctx as any, adopted.id, true);

    // killMux is coerced to false and the reason marks it a detach.
    expect(ctx.cleanupSession).toHaveBeenCalledWith(adopted.id, false, 'user_detach');
  });

  it('leaves a normal session as a full delete (killMux honored)', async () => {
    const ctx = createMockRouteContext();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await deleteSessionCore(ctx as any, ctx._sessionId, true);
    expect(ctx.cleanupSession).toHaveBeenCalledWith(ctx._sessionId, true, 'user_delete');
  });
});
