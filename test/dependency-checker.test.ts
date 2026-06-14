import { describe, it, expect } from 'vitest';
import { DEPENDENCY_REGISTRY } from '../src/config/dependency-registry.js';
import {
  detectEnvironment,
  extractVersion,
  compareVersions,
  checkTool,
  checkAll,
  createRealHost,
} from '../src/utils/dependency-checker.js';
import type { ProbeHost } from '../src/utils/dependency-checker.js';
import type { ProbeEnvironment, ToolDependency } from '../src/config/dependency-registry.js';

describe('DEPENDENCY_REGISTRY', () => {
  it('has unique ids', () => {
    const ids = DEPENDENCY_REGISTRY.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('hard-requires only node and tmux; agent CLIs and office are optional', () => {
    const required = DEPENDENCY_REGISTRY.filter((t) => t.required)
      .map((t) => t.id)
      .sort();
    expect(required).toEqual(['node', 'tmux']);
    // all four agent CLIs are optional (Codeman runs any of them)
    const agentClis = ['claude', 'opencode', 'codex', 'gemini'];
    expect(DEPENDENCY_REGISTRY.filter((t) => agentClis.includes(t.id)).every((t) => t.required === false)).toBe(true);
    const office = DEPENDENCY_REGISTRY.filter((t) => t.category === 'office');
    expect(office.every((t) => t.required === false)).toBe(true);
  });

  it('gives msoffice a windows-side resolver scoped to wsl + win32 only', () => {
    const ms = DEPENDENCY_REGISTRY.find((t) => t.id === 'msoffice');
    expect(ms).toBeDefined();
    const spec = ms!.resolvers.find((r) => r.resolver.kind === 'windows-side');
    expect(spec).toBeDefined();
    expect([...spec!.match].sort()).toEqual(['win32', 'wsl']);
    expect(ms!.resolvers.some((r) => r.match.includes('linux'))).toBe(false);
  });
});

describe('detectEnvironment', () => {
  it('returns win32/darwin straight from platform', () => {
    expect(detectEnvironment({ platform: 'win32', procVersion: '', hasWindowsInterop: false })).toBe('win32');
    expect(detectEnvironment({ platform: 'darwin', procVersion: '', hasWindowsInterop: false })).toBe('darwin');
  });

  it('detects wsl from /proc/version + interop, else linux', () => {
    const wsl = detectEnvironment({
      platform: 'linux',
      procVersion: 'Linux version 6.6 (Microsoft@WSL2)',
      hasWindowsInterop: true,
    });
    expect(wsl).toBe('wsl');
    expect(detectEnvironment({ platform: 'linux', procVersion: 'Microsoft', hasWindowsInterop: false })).toBe('linux');
    expect(detectEnvironment({ platform: 'linux', procVersion: 'generic', hasWindowsInterop: true })).toBe('linux');
  });
});

describe('extractVersion', () => {
  it('pulls a dotted version from typical --version output', () => {
    expect(extractVersion('v22.22.1')).toBe('22.22.1');
    expect(extractVersion('tmux 3.4')).toBe('3.4');
    expect(extractVersion('no digits here')).toBeUndefined();
  });
  it('honors a custom regex', () => {
    expect(extractVersion('ProductVersion 16.0.19929.20172', /(\d+\.\d+\.\d+)/)).toBe('16.0.19929');
  });
});

describe('compareVersions', () => {
  it('orders by numeric components', () => {
    expect(compareVersions('18.0.0', '18.0.0')).toBe(0);
    expect(compareVersions('16.5.0', '18.0.0')).toBe(-1);
    expect(compareVersions('22.22.1', '18.0.0')).toBe(1);
    expect(compareVersions('3.4', '3.4.0')).toBe(0);
  });
});

function fakeHost(env: ProbeEnvironment, over: Partial<ProbeHost> = {}): ProbeHost {
  return {
    environment: env,
    which: () => null,
    fileExists: () => false,
    runVersion: () => null,
    windowsProgramRoots: () => [],
    windowsFileVersion: () => null,
    ...over,
  };
}

const tmuxTool: ToolDependency = {
  id: 'tmux',
  label: 'tmux',
  category: 'core',
  required: true,
  resolvers: [{ match: ['linux', 'wsl'], resolver: { kind: 'path', bins: ['tmux'], versionArg: '-V' } }],
};
const nodeTool: ToolDependency = {
  id: 'node',
  label: 'Node.js',
  category: 'core',
  required: true,
  minVersion: '18.0.0',
  resolvers: [{ match: ['linux'], resolver: { kind: 'path', bins: ['node'] } }],
};
const msTool: ToolDependency = {
  id: 'msoffice',
  label: 'MS Office',
  category: 'office',
  required: false,
  resolvers: [
    {
      match: ['wsl', 'win32'],
      resolver: { kind: 'windows-side', appDirs: ['Microsoft Office/root/Office16'], exes: ['WINWORD.EXE'] },
    },
  ],
};

describe('checkTool', () => {
  it('reports ok with path + version when found on PATH', () => {
    const host = fakeHost('linux', {
      which: (b) => (b === 'tmux' ? '/usr/bin/tmux' : null),
      runVersion: () => 'tmux 3.4',
    });
    expect(checkTool(tmuxTool, host)).toMatchObject({
      id: 'tmux',
      status: 'ok',
      version: '3.4',
      path: '/usr/bin/tmux',
    });
  });

  it('reports missing when no bin resolves', () => {
    expect(checkTool(tmuxTool, fakeHost('linux'))).toMatchObject({ id: 'tmux', status: 'missing' });
  });

  it('reports outdated when below minVersion', () => {
    const host = fakeHost('linux', { which: () => '/n', runVersion: () => 'v16.5.0' });
    expect(checkTool(nodeTool, host)).toMatchObject({ id: 'node', status: 'outdated', version: '16.5.0' });
  });

  it('reports error when minVersion set but version unparseable', () => {
    const host = fakeHost('linux', { which: () => '/n', runVersion: () => 'unknown' });
    expect(checkTool(nodeTool, host)).toMatchObject({ id: 'node', status: 'error' });
  });

  it('reports skipped when no resolver matches the environment', () => {
    expect(checkTool(msTool, fakeHost('linux'))).toMatchObject({ id: 'msoffice', status: 'skipped' });
  });

  it('finds windows-side apps under WSL', () => {
    const host = fakeHost('wsl', {
      windowsProgramRoots: () => ['/mnt/c/Program Files'],
      fileExists: (p) => p === '/mnt/c/Program Files/Microsoft Office/root/Office16/WINWORD.EXE',
      windowsFileVersion: () => '16.0.19929.20172',
    });
    expect(checkTool(msTool, host)).toMatchObject({
      id: 'msoffice',
      status: 'ok',
      version: '16.0.19929',
      path: '/mnt/c/Program Files/Microsoft Office/root/Office16/WINWORD.EXE',
    });
  });
});

describe('checkAll', () => {
  it('maps every tool to a result', () => {
    const results = checkAll([tmuxTool, msTool], fakeHost('linux'));
    expect(results.map((r) => r.id)).toEqual(['tmux', 'msoffice']);
  });
});

describe('createRealHost', () => {
  it('returns a host with a valid detected environment and callable methods', () => {
    const host = createRealHost();
    expect(['linux', 'darwin', 'win32', 'wsl']).toContain(host.environment);
    expect(typeof host.which).toBe('function');
    expect(Array.isArray(host.windowsProgramRoots())).toBe(true);
  });
});
