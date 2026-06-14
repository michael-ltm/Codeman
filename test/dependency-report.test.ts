import { describe, it, expect } from 'vitest';
import { renderTable, renderJson, computeExitCode } from '../src/utils/dependency-report.js';
import type { ToolResult } from '../src/utils/dependency-checker.js';

const results: ToolResult[] = [
  {
    id: 'node',
    label: 'Node.js',
    category: 'core',
    required: true,
    usedBy: [],
    status: 'ok',
    version: '22.22.1',
    path: '/n',
  },
  {
    id: 'tmux',
    label: 'tmux',
    category: 'core',
    required: true,
    usedBy: [],
    status: 'missing',
    installHint: 'sudo apt install tmux',
  },
  {
    id: 'libreoffice',
    label: 'LibreOffice',
    category: 'office',
    required: false,
    usedBy: ['document preview', 'thumbnails'],
    status: 'missing',
  },
  {
    id: 'msoffice',
    label: 'MS Office',
    category: 'office',
    required: false,
    usedBy: ['document preview', 'thumbnails'],
    status: 'skipped',
    reason: 'not applicable on linux',
  },
];

describe('computeExitCode', () => {
  it('non-zero when a required tool is missing/outdated/error', () => {
    expect(computeExitCode(results)).toBe(1);
  });
  it('zero when only optional tools are missing', () => {
    const ok = results.filter((r) => r.id !== 'tmux');
    expect(computeExitCode(ok)).toBe(0);
  });
});

describe('renderTable', () => {
  it('groups by category and shows status, version, and install hints', () => {
    const out = renderTable(results, 'linux');
    expect(out).toContain('CORE');
    expect(out).toContain('Node.js');
    expect(out).toContain('22.22.1');
    expect(out).toContain('OFFICE');
    expect(out).toContain('document preview');
    expect(out).toContain('sudo apt install tmux');
  });
});

describe('renderJson', () => {
  it('includes environment, summary, and per-tool data', () => {
    const json = renderJson(results, 'linux');
    expect(json.platform.environment).toBe('linux');
    expect(json.summary.exitCode).toBe(1);
    expect(json.summary.ok).toBe(1);
    expect(json.tools).toHaveLength(4);
  });
});
