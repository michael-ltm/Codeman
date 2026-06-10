/**
 * @fileoverview Resolve the Codex (OpenAI) CLI binary across common install paths.
 *
 * Mirrors opencode-cli-resolver.ts pattern. Finds the `codex` binary
 * and provides an augmented PATH string for tmux sessions.
 *
 * @module utils/codex-cli-resolver
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { EXEC_TIMEOUT_MS } from '../config/exec-timeout.js';

/** Common directories where the Codex CLI binary may be installed */
const CODEX_SEARCH_DIRS = [
  join(homedir(), '.codex', 'bin'), // Default install location
  join(homedir(), '.local', 'bin'), // Alternative install location
  '/usr/local/bin', // Homebrew / system
  join(homedir(), '.bun', 'bin'), // Bun global
  join(homedir(), '.npm-global', 'bin'), // npm global
  join(homedir(), 'bin'), // User bin
];

/** Cached directory containing the codex binary (empty string = searched but not found) */
let _codexDir: string | null = null;

/**
 * Finds the directory containing the `codex` binary.
 * Checks `which codex` first, then falls back to common install locations.
 * Result is cached for subsequent calls.
 *
 * @returns Directory path, or null if not found
 */
export function resolveCodexDir(): string | null {
  if (_codexDir !== null) return _codexDir || null;

  // Try `which` first (respects current PATH)
  try {
    const result = execSync('which codex', {
      encoding: 'utf-8',
      timeout: EXEC_TIMEOUT_MS,
    }).trim();
    if (result && existsSync(result)) {
      _codexDir = dirname(result);
      return _codexDir;
    }
  } catch {
    // Codex not in PATH, will check common locations
  }

  for (const dir of CODEX_SEARCH_DIRS) {
    if (existsSync(join(dir, 'codex'))) {
      _codexDir = dir;
      return _codexDir;
    }
  }

  _codexDir = ''; // mark as searched, not found
  return null;
}

/**
 * Check if Codex CLI is available on the system.
 */
export function isCodexAvailable(): boolean {
  return resolveCodexDir() !== null;
}
