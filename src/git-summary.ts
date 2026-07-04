/**
 * @fileoverview Lightweight Git status summaries for session navigation UI.
 *
 * The summary is intentionally best-effort: non-git folders, slow repos, or
 * missing git binaries simply return undefined so the session list can omit
 * the metadata instead of showing an error.
 */

import { execFileSync } from 'node:child_process';

const GIT_TIMEOUT_MS = 900;
const GIT_MAX_BUFFER = 512 * 1024;
const DEFAULT_TTL_MS = 5000;

export type GitSyncStatus = 'pushable' | 'behind' | 'diverged' | 'synced' | 'no-upstream';

export interface GitSummary {
  isRepo: true;
  branch: string;
  upstream?: string;
  ahead: number;
  behind: number;
  pushable: boolean;
  syncStatus: GitSyncStatus;
  dirty: boolean;
  changedFiles: number;
  untrackedFiles: number;
  insertions: number;
  deletions: number;
}

interface CacheEntry {
  expiresAt: number;
  value: GitSummary | undefined;
}

const cache = new Map<string, CacheEntry>();

function git(workingDir: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', workingDir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    }).trimEnd();
  } catch {
    return null;
  }
}

function parseBranchLine(line: string): Pick<GitSummary, 'branch' | 'upstream' | 'ahead' | 'behind'> | null {
  if (!line.startsWith('## ')) return null;

  const raw = line.slice(3);
  const bracketMatch = raw.match(/\s+\[([^\]]+)\]$/);
  const tracking = bracketMatch ? bracketMatch[1] : '';
  const refText = bracketMatch ? raw.slice(0, bracketMatch.index).trim() : raw.trim();
  const [branchRaw, upstreamRaw] = refText.split('...');
  const unborn = branchRaw.match(/^No commits yet on (.+)$/);
  const branch = (unborn ? unborn[1] : branchRaw).replace(/^HEAD \(no branch\)$/, 'HEAD').trim();
  const upstream = upstreamRaw?.trim() || undefined;
  const ahead = Number(tracking.match(/ahead (\d+)/)?.[1] || 0);
  const behind = Number(tracking.match(/behind (\d+)/)?.[1] || 0);

  return branch ? { branch, upstream, ahead, behind } : null;
}

function parseNumstat(output: string | null): Pick<GitSummary, 'insertions' | 'deletions'> {
  let insertions = 0;
  let deletions = 0;
  for (const line of (output || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [added, removed] = line.split('\t');
    if (/^\d+$/.test(added)) insertions += Number(added);
    if (/^\d+$/.test(removed)) deletions += Number(removed);
  }
  return { insertions, deletions };
}

function syncStatus(upstream: string | undefined, ahead: number, behind: number): GitSyncStatus {
  if (!upstream) return 'no-upstream';
  if (ahead > 0 && behind > 0) return 'diverged';
  if (ahead > 0) return 'pushable';
  if (behind > 0) return 'behind';
  return 'synced';
}

export function clearGitSummaryCache(): void {
  cache.clear();
}

export function collectGitSummary(
  workingDir: string,
  opts: { ttlMs?: number; now?: number } = {}
): GitSummary | undefined {
  if (!workingDir) return undefined;

  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? Date.now();
  const cached = cache.get(workingDir);
  if (ttlMs > 0 && cached && cached.expiresAt > now) return cached.value;

  const statusOutput = git(workingDir, ['status', '--porcelain=v1', '--branch', '--untracked-files=normal']);
  const value = statusOutput ? buildSummaryFromStatus(workingDir, statusOutput) : undefined;
  if (ttlMs > 0) cache.set(workingDir, { value, expiresAt: now + ttlMs });
  return value;
}

function buildSummaryFromStatus(workingDir: string, statusOutput: string): GitSummary | undefined {
  const [branchLine = '', ...changeLines] = statusOutput.split(/\r?\n/);
  const branch = parseBranchLine(branchLine);
  if (!branch) return undefined;

  const changedFiles = changeLines.filter((line) => line.trim()).length;
  const untrackedFiles = changeLines.filter((line) => line.startsWith('??')).length;
  const numstat = parseNumstat(git(workingDir, ['diff', '--numstat', 'HEAD', '--']));
  const state = syncStatus(branch.upstream, branch.ahead, branch.behind);

  return {
    isRepo: true,
    branch: branch.branch,
    upstream: branch.upstream,
    ahead: branch.ahead,
    behind: branch.behind,
    pushable: state === 'pushable',
    syncStatus: state,
    dirty: changedFiles > 0,
    changedFiles,
    untrackedFiles,
    insertions: numstat.insertions,
    deletions: numstat.deletions,
  };
}
