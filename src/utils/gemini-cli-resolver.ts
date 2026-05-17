/**
 * @fileoverview Resolve the Gemini CLI binary across common install paths.
 *
 * Mirrors codex-cli-resolver.ts and opencode-cli-resolver.ts. Finds the
 * `gemini` binary and provides an augmented PATH directory for tmux sessions.
 *
 * @module utils/gemini-cli-resolver
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { EXEC_TIMEOUT_MS } from '../config/exec-timeout.js';

/** Common directories where the Gemini CLI binary may be installed */
const GEMINI_SEARCH_DIRS = [
  join(homedir(), '.gemini', 'bin'),
  join(homedir(), '.local', 'bin'),
  '/usr/local/bin',
  join(homedir(), '.bun', 'bin'),
  join(homedir(), '.npm-global', 'bin'),
  join(homedir(), 'bin'),
];

/** Cached directory containing the gemini binary (empty string = searched but not found) */
let _geminiDir: string | null = null;

/**
 * Finds the directory containing the `gemini` binary.
 * Checks `which gemini` first, then falls back to common install locations.
 *
 * @returns Directory path, or null if not found
 */
export function resolveGeminiDir(): string | null {
  if (_geminiDir !== null) return _geminiDir || null;

  try {
    const result = execSync('which gemini', {
      encoding: 'utf-8',
      timeout: EXEC_TIMEOUT_MS,
    }).trim();
    if (result && existsSync(result)) {
      _geminiDir = dirname(result);
      return _geminiDir;
    }
  } catch {
    // Gemini not in PATH, will check common locations
  }

  for (const dir of GEMINI_SEARCH_DIRS) {
    if (existsSync(join(dir, 'gemini'))) {
      _geminiDir = dir;
      return _geminiDir;
    }
  }

  _geminiDir = '';
  return null;
}

/**
 * Check if Gemini CLI is available on the system.
 */
export function isGeminiAvailable(): boolean {
  return resolveGeminiDir() !== null;
}
