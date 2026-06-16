import { describe, expect, it } from 'vitest';
import { Session, isAltScreenStripMode } from '../src/session.js';

type SessionInternals = {
  _handleTerminalOutput(data: string): void;
};

function handleOutput(session: Session, data: string): void {
  (session as unknown as SessionInternals)._handleTerminalOutput(data);
}

describe('isAltScreenStripMode', () => {
  it('strips for the controlled TUIs (codex + claude), not shell/opencode', () => {
    expect(isAltScreenStripMode('codex')).toBe(true);
    expect(isAltScreenStripMode('claude')).toBe(true);
    expect(isAltScreenStripMode('shell')).toBe(false);
    expect(isAltScreenStripMode('opencode')).toBe(false);
  });
});

describe('Claude terminal scrollback strip', () => {
  it('strips alt-screen toggles, scrollback-erase, and mouse-tracking', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'claude' });
    const emitted: string[] = [];
    session.on('terminal', (data) => emitted.push(data));

    handleOutput(session, '\x1b[?1049h\x1b[55;1Hdialog\x1b[3J\x1b[?1006h\x1b[?1049l');

    expect(emitted[0]).toBe('\x1b[55;1Hdialog');
    expect(session.terminalBuffer).toBe('\x1b[55;1Hdialog');
  });

  it('keeps the visible-screen erase (2J / [J) — only scrollback-erase (3J) is dropped', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'claude' });

    handleOutput(session, '\x1b[?1049h\x1b[2Jvisible\x1b[3Jscrollback\x1b[?1049l');

    expect(session.terminalBuffer).toBe('\x1b[2Jvisiblescrollback');
  });

  it('preserves an ordinary erase-display redraw (no scrollback sequences)', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'claude' });

    handleOutput(session, '\x1b[H\x1b[Jclaude redraw');

    expect(session.terminalBuffer).toBe('\x1b[H\x1b[Jclaude redraw');
  });

  it('strips sequences split across PTY chunk boundaries (carry reassembly)', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'claude' });
    const emitted: string[] = [];
    session.on('terminal', (data) => emitted.push(data));

    handleOutput(session, 'before\x1b[?104');
    handleOutput(session, '9h\x1b[2Jafter\x1b[3');
    handleOutput(session, 'Jtail');

    expect(session.terminalBuffer).toBe('before\x1b[2Jaftertail');
    expect(emitted).toEqual(['before', '\x1b[2Jafter', 'tail']);
  });

  it('emits nothing for a chunk that is only a partial CSI, then completes it', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'claude' });
    const emitted: string[] = [];
    session.on('terminal', (data) => emitted.push(data));

    handleOutput(session, '\x1b[?100'); // pure partial — held, nothing emitted
    handleOutput(session, '6h done'); // completes ?1006h (stripped); rest passes

    expect(emitted).toEqual([' done']);
    expect(session.terminalBuffer).toBe(' done');
  });

  it('does not touch ordinary Claude conversation output', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'claude' });

    const text = 'Here is line one\r\nHere is line two\r\n\x1b[2mdim status\x1b[0m';
    handleOutput(session, text);

    expect(session.terminalBuffer).toBe(text);
  });
});

describe('Shell terminal output is NOT stripped (vim/less/htop need the alt screen)', () => {
  it('leaves alt-screen toggles, scrollback-erase, and mouse-tracking intact for shell', () => {
    const session = new Session({ workingDir: '/tmp', mode: 'shell' });

    const vimLike = '\x1b[?1049h\x1b[?1002h\x1b[2J~ editing\x1b[3J\x1b[?1002l\x1b[?1049l';
    handleOutput(session, vimLike);

    expect(session.terminalBuffer).toBe(vimLike);
  });
});
