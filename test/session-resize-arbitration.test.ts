import { describe, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';

type ResizeableSessionInternals = {
  ptyProcess: { resize: (cols: number, rows: number) => void };
  _ptyCols: number;
  _ptyRows: number;
};

function attachFakePty(session: Session, cols = 160, rows = 48) {
  const resize = vi.fn();
  const internals = session as unknown as ResizeableSessionInternals;
  internals.ptyProcess = { resize };
  internals._ptyCols = cols;
  internals._ptyRows = rows;
  return resize;
}

describe('Session resize arbitration', () => {
  it('lets a mobile-only session shrink below the spawn default (no desktop connected)', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'shell' });
    const resize = attachFakePty(session, 160, 48);

    session.resize(48, 28, { viewportType: 'mobile' });

    expect(resize).toHaveBeenCalledWith(48, 28);
  });

  it('lets a mobile-only session shrink rows only', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'shell' });
    const resize = attachFakePty(session, 160, 48);

    session.resize(160, 28, { viewportType: 'mobile' });

    expect(resize).toHaveBeenCalledWith(160, 28);
  });

  it('lets a mobile-only session re-grow after shrinking', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'shell' });
    const resize = attachFakePty(session, 160, 48);

    session.resize(48, 28, { viewportType: 'mobile' });
    session.resize(80, 36, { viewportType: 'tablet' });

    expect(resize).toHaveBeenNthCalledWith(1, 48, 28);
    expect(resize).toHaveBeenNthCalledWith(2, 80, 36);
  });

  it('ignores mobile resizes while a desktop connection holds a sizing claim', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'shell' });
    const resize = attachFakePty(session, 160, 48);
    const desktop = Symbol('desktop-conn');

    session.claimDesktopSizing(desktop);
    session.resize(48, 28, { viewportType: 'mobile' });
    // Grow is ignored too — it would reflow the desktop view just the same.
    session.resize(200, 60, { viewportType: 'tablet' });

    expect(resize).not.toHaveBeenCalled();
  });

  it('always applies desktop resizes, claim or not', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'shell' });
    const resize = attachFakePty(session, 160, 48);

    session.claimDesktopSizing(Symbol('desktop-conn'));
    session.resize(120, 40, { viewportType: 'desktop' });

    expect(resize).toHaveBeenCalledWith(120, 40);
  });

  it('restores mobile control once the desktop claim is released', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'shell' });
    const resize = attachFakePty(session, 160, 48);
    const desktop = Symbol('desktop-conn');

    session.claimDesktopSizing(desktop);
    session.resize(48, 28, { viewportType: 'mobile' });
    expect(resize).not.toHaveBeenCalled();

    session.releaseDesktopSizing(desktop);
    session.resize(48, 28, { viewportType: 'mobile' });
    expect(resize).toHaveBeenCalledWith(48, 28);
  });

  it('keeps ignoring mobile resizes until every desktop claim is released', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'shell' });
    const resize = attachFakePty(session, 160, 48);
    const desktopA = Symbol('desktop-a');
    const desktopB = Symbol('desktop-b');

    session.claimDesktopSizing(desktopA);
    session.claimDesktopSizing(desktopB);
    session.releaseDesktopSizing(desktopA);
    session.resize(48, 28, { viewportType: 'mobile' });
    expect(resize).not.toHaveBeenCalled();

    session.releaseDesktopSizing(desktopB);
    session.resize(48, 28, { viewportType: 'mobile' });
    expect(resize).toHaveBeenCalledWith(48, 28);
  });

  it('applies untyped (legacy/API) resizes regardless of claims', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'shell' });
    const resize = attachFakePty(session, 160, 48);

    session.claimDesktopSizing(Symbol('desktop-conn'));
    session.resize(100, 30);

    expect(resize).toHaveBeenCalledWith(100, 30);
  });
});
