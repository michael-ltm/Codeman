/**
 * @fileoverview Tests for listDirsSafe (src/fleet/dir-listing.ts) — the pure,
 * security-critical directory browser behind the fleet `list-dirs` RPC / the
 * `GET /api/fleet/devices/:deviceId/dirs` route.
 *
 * A real tmpdir "home" fixture is built with nested dirs, plain files, a
 * dotdir, and symlinks (one pointing inside home, one pointing to /etc) so the
 * escape-prevention rules (spec §12.1) are exercised against the real fs:
 * - default path = $HOME → lists top-level dirs only (never files, never dotdirs)
 * - a subdir path inside home → lists that subdir's dirs
 * - `../` traversal that resolves outside home → throws 'Path outside home'
 * - an absolute path outside home → throws 'Path outside home'
 * - a requestedPath that IS a symlink resolving outside home → throws
 * - a symlink ENTRY (to inside or outside) is excluded from results (lstat-based)
 * - >200 entries capped at 200
 *
 * Uses os.mkdtemp so each run is isolated; realpath is used on the fixture root
 * because macOS /var/folders is itself a symlink to /private/var/folders.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listDirsSafe } from '../../src/fleet/dir-listing.js';

let home: string;

beforeAll(() => {
  // realpath so the fixture root itself is canonical (macOS tmpdir is a symlink)
  home = realpathSync(mkdtempSync(join(tmpdir(), 'fleet-dir-')));
  // top-level dirs + files
  mkdirSync(join(home, 'projects'));
  mkdirSync(join(home, 'documents'));
  mkdirSync(join(home, 'apple')); // sort-order check: comes before 'documents'
  mkdirSync(join(home, '.hidden')); // dotdir — must be excluded
  writeFileSync(join(home, 'notes.txt'), 'x'); // plain file — must never be listed
  writeFileSync(join(home, 'README'), 'x');
  // nested dir under projects
  mkdirSync(join(home, 'projects', 'alpha'));
  writeFileSync(join(home, 'projects', 'beta.txt'), 'x');
  // symlink to inside home (a real dir) — must be EXCLUDED (lstat, not stat)
  symlinkSync(join(home, 'projects'), join(home, 'link-inside'));
  // symlink to OUTSIDE home (/etc) — must be EXCLUDED, never followed
  symlinkSync('/etc', join(home, 'link-etc'));
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('listDirsSafe', () => {
  it('defaults to $HOME and lists only top-level directories, sorted, no files/dotdirs', () => {
    const { path, dirs } = listDirsSafe(undefined, home);
    expect(path).toBe(home);
    expect(dirs).toEqual(['apple', 'documents', 'projects']);
    expect(dirs).not.toContain('notes.txt');
    expect(dirs).not.toContain('README');
    expect(dirs).not.toContain('.hidden');
  });

  it('excludes symlink entries (to inside AND to outside home)', () => {
    const { dirs } = listDirsSafe(home, home);
    expect(dirs).not.toContain('link-inside');
    expect(dirs).not.toContain('link-etc');
  });

  it('lists a subdirectory inside home', () => {
    const { path, dirs } = listDirsSafe(join(home, 'projects'), home);
    expect(path).toBe(join(home, 'projects'));
    expect(dirs).toEqual(['alpha']);
    expect(dirs).not.toContain('beta.txt');
  });

  it("throws on a '../' traversal that resolves outside home", () => {
    expect(() => listDirsSafe(join(home, '..', '..'), home)).toThrow('Path outside home');
  });

  it('throws on an absolute path outside home', () => {
    expect(() => listDirsSafe('/etc', home)).toThrow('Path outside home');
  });

  it('throws when the requestedPath itself is a symlink resolving outside home', () => {
    // link-etc → /etc: realpath escapes home, so the whole request is rejected.
    expect(() => listDirsSafe(join(home, 'link-etc'), home)).toThrow('Path outside home');
  });

  it('throws on a non-existent path', () => {
    expect(() => listDirsSafe(join(home, 'does-not-exist'), home)).toThrow('Path outside home');
  });

  it('caps results at 200 directories', () => {
    const big = realpathSync(mkdtempSync(join(tmpdir(), 'fleet-big-')));
    try {
      for (let i = 0; i < 250; i++) {
        mkdirSync(join(big, `d${String(i).padStart(3, '0')}`));
      }
      const { dirs } = listDirsSafe(undefined, big);
      expect(dirs.length).toBe(200);
      // sorted → the first 200 alphabetically
      expect(dirs[0]).toBe('d000');
      expect(dirs[199]).toBe('d199');
    } finally {
      rmSync(big, { recursive: true, force: true });
    }
  });

  it('treats an empty-string path as the default home', () => {
    const { path } = listDirsSafe('', home);
    expect(path).toBe(home);
  });
});
