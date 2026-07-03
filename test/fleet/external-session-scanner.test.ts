/**
 * @fileoverview Tests for ExternalSessionScanner (src/fleet/external-session-scanner.ts).
 *
 * The scanner discovers AI-CLI sessions running inside FOREIGN tmux servers by
 * running exactly two read-only commands: `ps -axo pid=,ppid=,comm=` (one
 * snapshot per scan) and `tmux [-L <sock>] list-panes -a -F ...`. Every exec
 * is routed through an injected `execImpl` so these tests never touch a real
 * tmux server or the process table — they feed canned `ps`/`list-panes` output
 * and assert the parsed candidate set, own-socket exclusion, firstSeenAt
 * stability, change-only emission, silent foreign-server errors, and the
 * READ-ONLY guarantee (execImpl is only ever called with the two list commands).
 *
 * No port needed (pure in-memory, execImpl-mocked).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ExternalSessionScanner } from '../../src/fleet/external-session-scanner.js';
import type { ExternalSessionCandidate } from '../../src/fleet/protocol.js';

const OWN_SOCKET = 'codeman';

/**
 * A `ps -axo pid=,ppid=,comm=` snapshot. tmux pane shells (zsh) host the AI
 * process as a child, so the scanner must walk the tree down from the pane pid.
 *   500  zsh          (pane pid for the default-server "work" session)
 *   501    claude     (child of 500)  -> claude mode
 *   600  zsh          (pane pid for the default-server "idle" session; no AI)
 *   700  zsh          (pane pid for the -L box session)
 *   701    codex      (child of 700, given as a full path) -> codex mode
 *   800  Codex        (a GUI app basename, capital C — must NOT match)
 */
const PS_SNAPSHOT = [
  '  500     1 /bin/zsh',
  '  501   500 /Users/ming/.local/bin/claude',
  '  600     1 /bin/zsh',
  '  700     1 /bin/zsh',
  '  701   700 /opt/homebrew/bin/codex',
  '  800     1 /Applications/Codex.app/Contents/MacOS/Codex',
].join('\n');

const TAB = '\t';

/** Build one `list-panes -F '#{session_name}\t#{pane_pid}\t#{pane_current_path}'` line. */
function paneLine(session: string, pid: number, cwd: string): string {
  return `${session}${TAB}${pid}${TAB}${cwd}`;
}

interface ExecCall {
  file: string;
  args: readonly string[];
}

/**
 * A canned execImpl. `panesBySocket` maps a socket name ('' = default server)
 * to its `list-panes` stdout; a socket absent from the map REJECTS (models a
 * server that isn't running — the normal case the scanner must swallow).
 */
function makeExec(opts: { ps?: string; panesBySocket: Record<string, string>; psFails?: boolean }): {
  exec: (file: string, args: readonly string[]) => Promise<string>;
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];
  const exec = (file: string, args: readonly string[]): Promise<string> => {
    calls.push({ file, args });
    if (file === 'ps') {
      if (opts.psFails) return Promise.reject(new Error('ps failed'));
      return Promise.resolve(opts.ps ?? PS_SNAPSHOT);
    }
    if (file === 'tmux') {
      // Default server: no -L; -L server: ['-L', <name>, 'list-panes', ...].
      const lIdx = args.indexOf('-L');
      const socket = lIdx >= 0 ? String(args[lIdx + 1]) : '';
      const out = opts.panesBySocket[socket];
      if (out === undefined) return Promise.reject(new Error('no server running'));
      return Promise.resolve(out);
    }
    return Promise.reject(new Error(`unexpected exec: ${file}`));
  };
  return { exec, calls };
}

const MUTATING_TOKENS = [
  'send-keys',
  'send',
  'kill-session',
  'kill-server',
  'kill-pane',
  'attach',
  'attach-session',
  'set-environment',
  'setenv',
  'run-shell',
  'new-session',
  'respawn-pane',
];

/** Asserts the scanner only ever ran the two read-only list commands. */
function assertReadOnly(calls: ExecCall[]): void {
  for (const call of calls) {
    if (call.file === 'ps') continue;
    expect(call.file, `unexpected exec binary: ${call.file}`).toBe('tmux');
    expect(call.args, 'tmux exec must be a list-panes read').toContain('list-panes');
    for (const token of MUTATING_TOKENS) {
      expect(call.args, `mutating tmux subcommand leaked: ${token}`).not.toContain(token);
    }
  }
}

describe('ExternalSessionScanner', () => {
  let savedAdopt: string | undefined;

  beforeEach(() => {
    savedAdopt = process.env.CODEMAN_ADOPT_SOCKETS;
    delete process.env.CODEMAN_ADOPT_SOCKETS;
  });

  afterEach(() => {
    if (savedAdopt === undefined) delete process.env.CODEMAN_ADOPT_SOCKETS;
    else process.env.CODEMAN_ADOPT_SOCKETS = savedAdopt;
  });

  it('discovers claude/codex sessions by walking the pane process tree', async () => {
    process.env.CODEMAN_ADOPT_SOCKETS = 'box';
    const { exec, calls } = makeExec({
      panesBySocket: {
        '': [paneLine('work', 500, '/home/ming/work'), paneLine('idle', 600, '/home/ming')].join('\n'),
        box: paneLine('remote', 700, '/srv/app'),
      },
    });
    const scanner = new ExternalSessionScanner({ ownSocket: OWN_SOCKET, execImpl: exec });

    await scanner.scanNow();

    const cands = scanner.getCandidates();
    // work(claude) + remote(codex); the "idle" session has no AI descendant.
    expect(cands).toHaveLength(2);
    expect(cands).toContainEqual(
      expect.objectContaining({ socket: '', tmuxSession: 'work', mode: 'claude', workingDir: '/home/ming/work' })
    );
    expect(cands).toContainEqual(
      expect.objectContaining({ socket: 'box', tmuxSession: 'remote', mode: 'codex', workingDir: '/srv/app' })
    );
    for (const c of cands) expect(typeof c.firstSeenAt).toBe('number');
    assertReadOnly(calls);
  });

  it('never scans its own codeman socket (own-socket exclusion)', async () => {
    process.env.CODEMAN_ADOPT_SOCKETS = `${OWN_SOCKET},box`;
    const { exec, calls } = makeExec({
      panesBySocket: { '': '', box: '' },
    });
    const scanner = new ExternalSessionScanner({ ownSocket: OWN_SOCKET, execImpl: exec });

    await scanner.scanNow();

    const tmuxCalls = calls.filter((c) => c.file === 'tmux');
    const scannedSockets = tmuxCalls.map((c) => {
      const i = c.args.indexOf('-L');
      return i >= 0 ? c.args[i + 1] : '';
    });
    expect(scannedSockets).toContain(''); // default server always scanned
    expect(scannedSockets).toContain('box');
    expect(scannedSockets).not.toContain(OWN_SOCKET); // ← the guarantee
  });

  it('keeps firstSeenAt stable across scans and dedupes by socket+session', async () => {
    const { exec } = makeExec({
      panesBySocket: { '': paneLine('work', 500, '/home/ming/work') },
    });
    const scanner = new ExternalSessionScanner({ ownSocket: OWN_SOCKET, execImpl: exec });

    await scanner.scanNow();
    const first = scanner.getCandidates();
    expect(first).toHaveLength(1);
    const firstSeenAt = first[0].firstSeenAt;

    await new Promise((r) => setTimeout(r, 5));
    await scanner.scanNow();
    const second = scanner.getCandidates();
    expect(second).toHaveLength(1);
    expect(second[0].firstSeenAt).toBe(firstSeenAt); // stable while it persists
  });

  it("emits 'changed' only when the deduped set actually changes", async () => {
    const panes: Record<string, string> = { '': paneLine('work', 500, '/home/ming/work') };
    const exec = (file: string, args: readonly string[]): Promise<string> => {
      if (file === 'ps') return Promise.resolve(PS_SNAPSHOT);
      const i = args.indexOf('-L');
      const socket = i >= 0 ? String(args[i + 1]) : '';
      const out = panes[socket];
      return out === undefined ? Promise.reject(new Error('no server')) : Promise.resolve(out);
    };
    const scanner = new ExternalSessionScanner({ ownSocket: OWN_SOCKET, execImpl: exec });
    const onChanged = vi.fn();
    scanner.on('changed', onChanged);

    await scanner.scanNow(); // [] -> [work] : change
    expect(onChanged).toHaveBeenCalledTimes(1);

    await scanner.scanNow(); // [work] -> [work] : no change
    expect(onChanged).toHaveBeenCalledTimes(1);

    panes[''] = [paneLine('work', 500, '/home/ming/work'), paneLine('remote', 700, '/srv/app')].join('\n');
    await scanner.scanNow(); // [work] -> [work, remote] : change
    expect(onChanged).toHaveBeenCalledTimes(2);
    const last = onChanged.mock.calls[1][0] as ExternalSessionCandidate[];
    expect(last).toHaveLength(2);
  });

  it('is silent when a foreign server is not running (exec rejects)', async () => {
    // Neither the default nor the extra socket has a running server.
    process.env.CODEMAN_ADOPT_SOCKETS = 'box';
    const { exec, calls } = makeExec({ panesBySocket: {} });
    const scanner = new ExternalSessionScanner({ ownSocket: OWN_SOCKET, execImpl: exec });
    const onChanged = vi.fn();
    scanner.on('changed', onChanged);

    await expect(scanner.scanNow()).resolves.toBeUndefined(); // does not throw
    expect(scanner.getCandidates()).toEqual([]);
    expect(onChanged).not.toHaveBeenCalled(); // empty→empty is no change
    assertReadOnly(calls);
  });

  it('only ever runs the two read-only list commands (READ-ONLY guarantee)', async () => {
    process.env.CODEMAN_ADOPT_SOCKETS = 'box';
    const { exec, calls } = makeExec({
      panesBySocket: {
        '': paneLine('work', 500, '/home/ming/work'),
        box: paneLine('remote', 700, '/srv/app'),
      },
    });
    const scanner = new ExternalSessionScanner({ ownSocket: OWN_SOCKET, execImpl: exec });

    await scanner.scanNow();

    expect(calls.length).toBeGreaterThan(0);
    // Exactly one ps snapshot per scan.
    expect(calls.filter((c) => c.file === 'ps')).toHaveLength(1);
    // Every tmux call is a list-panes read; nothing mutating ever runs.
    assertReadOnly(calls);
    for (const c of calls.filter((c) => c.file === 'tmux')) {
      expect(c.args).toContain('list-panes');
      expect(c.args).toContain('-a');
    }
  });
});
