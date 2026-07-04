import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { collectGitSummary } from '../src/git-summary.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

describe('git summary', () => {
  it('reports branch, +/- line stats, untracked files, and pushability against upstream', () => {
    const root = mkdtempSync(join(tmpdir(), 'codeman-git-summary-'));
    const remote = mkdtempSync(join(tmpdir(), 'codeman-git-summary-remote-'));
    try {
      git(remote, ['init', '--bare']);
      git(root, ['init']);
      git(root, ['checkout', '-b', 'main']);
      git(root, ['config', 'user.email', 'codeman@example.test']);
      git(root, ['config', 'user.name', 'Codeman Test']);
      writeFileSync(join(root, 'tracked.txt'), 'old\nkeep\n');
      git(root, ['add', 'tracked.txt']);
      git(root, ['commit', '-m', 'initial']);
      git(root, ['remote', 'add', 'origin', remote]);
      git(root, ['push', '-u', 'origin', 'main']);

      writeFileSync(join(root, 'committed.txt'), 'ready\n');
      git(root, ['add', 'committed.txt']);
      git(root, ['commit', '-m', 'local commit']);
      writeFileSync(join(root, 'tracked.txt'), 'new\nkeep\nextra\n');
      writeFileSync(join(root, 'draft.txt'), 'untracked\n');

      const summary = collectGitSummary(root);

      expect(summary).toMatchObject({
        isRepo: true,
        branch: 'main',
        upstream: 'origin/main',
        ahead: 1,
        behind: 0,
        pushable: true,
        insertions: 2,
        deletions: 1,
        untrackedFiles: 1,
        dirty: true,
      });
      expect(summary?.changedFiles).toBeGreaterThanOrEqual(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
    }
  });
});
