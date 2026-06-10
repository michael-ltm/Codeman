/**
 * @fileoverview Claude Code hooks configuration generator.
 *
 * Generates `.claude/settings.local.json` with hook definitions that POST
 * to Codeman's `/api/hook-event` endpoint when Claude Code fires hooks.
 * Uses `$CODEMAN_API_URL`, `$CODEMAN_SESSION_ID`, and `$CODEMAN_HOOK_SECRET_FILE`
 * env vars (set on every managed session) so the config is static per case
 * directory and free of secret values.
 *
 * Key exports:
 * - `generateHooksConfig()` — returns hooks object for settings.local.json
 * - `writeHooksConfig(casePath)` — writes hooks + env config to disk
 * - `updateCaseEnvVars(casePath, envVars)` — merges env vars into settings
 *
 * Hook events generated: `idle_prompt`, `permission_prompt`, `elicitation_dialog`,
 * `stop`, `teammate_idle`, `task_completed`
 *
 * Hook categories: `Notification` (3 matchers), `Stop` (1), `TeammateIdle` (1),
 * `TaskCompleted` (1)
 *
 * @dependencies types (HookEventType), config/auth-config (HOOK_TIMEOUT_MS)
 * @consumedby web/server (session creation), session-cli-builder (env setup)
 *
 * @module hooks-config
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { HookEventType } from './types.js';
import { HOOK_TIMEOUT_MS } from './config/auth-config.js';

/**
 * Generates the hooks section for .claude/settings.local.json
 *
 * The hook commands read stdin JSON from Claude Code (contains tool_name,
 * tool_input, etc.) and forward it as the `data` field to Codeman's API.
 * Env vars are resolved at runtime by the shell, so the config is static
 * per case directory.
 */
export function generateHooksConfig(): { hooks: Record<string, unknown[]> } {
  // Read Claude Code's stdin JSON and forward it as the data field.
  // Falls back to empty object if stdin is unavailable or malformed.
  // COD-54: present the per-instance hook secret so the bypass keeps working while
  // a tunnel is running. The value is read from the secret file AT EXECUTION TIME
  // (path via $CODEMAN_HOOK_SECRET_FILE, set in every managed session's env), so it
  // never lands in this config and rotation needs no respawn. If the var/file is
  // missing the header is empty — the middleware then allows the request only on
  // the plain loopback bypass (tunnel down), same as pre-secret behavior.
  const curlCmd = (event: HookEventType) =>
    `HOOK_DATA=$(cat 2>/dev/null || echo '{}'); ` +
    `printf '{"event":"${event}","sessionId":"%s","data":%s}' "$CODEMAN_SESSION_ID" "$HOOK_DATA" | ` +
    `curl -s -X POST "$CODEMAN_API_URL/api/hook-event" ` +
    `-H 'Content-Type: application/json' ` +
    `-H "X-Codeman-Hook-Secret: $(cat "$CODEMAN_HOOK_SECRET_FILE" 2>/dev/null)" ` +
    `--data @- ` +
    `2>/dev/null || true`;

  return {
    hooks: {
      Notification: [
        {
          matcher: 'idle_prompt',
          hooks: [{ type: 'command', command: curlCmd('idle_prompt'), timeout: HOOK_TIMEOUT_MS }],
        },
        {
          matcher: 'permission_prompt',
          hooks: [{ type: 'command', command: curlCmd('permission_prompt'), timeout: HOOK_TIMEOUT_MS }],
        },
        {
          matcher: 'elicitation_dialog',
          hooks: [{ type: 'command', command: curlCmd('elicitation_dialog'), timeout: HOOK_TIMEOUT_MS }],
        },
      ],
      Stop: [
        {
          hooks: [{ type: 'command', command: curlCmd('stop'), timeout: HOOK_TIMEOUT_MS }],
        },
      ],
      TeammateIdle: [
        {
          hooks: [{ type: 'command', command: curlCmd('teammate_idle'), timeout: HOOK_TIMEOUT_MS }],
        },
      ],
      TaskCompleted: [
        {
          hooks: [{ type: 'command', command: curlCmd('task_completed'), timeout: HOOK_TIMEOUT_MS }],
        },
      ],
    },
  };
}

/**
 * Remove a subset of env keys from .claude/settings.local.json.env if present.
 * Used during the disk→tmux-setenv migration: when the caller is actively setting
 * a fresh value for a Codeman-managed key, any stale disk entry for THAT KEY is
 * superseded and should be removed. Keys NOT in `keysToRemove` are left alone
 * (they may be user-managed). No-op if the file/keys don't exist.
 */
export async function stripCaseEnvKeys(casePath: string, keysToRemove: readonly string[]): Promise<void> {
  if (keysToRemove.length === 0) return;

  const settingsPath = join(casePath, '.claude', 'settings.local.json');
  if (!existsSync(settingsPath)) return;

  let existing: Record<string, unknown>;
  try {
    existing = JSON.parse(await readFile(settingsPath, 'utf-8'));
  } catch {
    return; // Malformed — don't rewrite it
  }

  const env = existing.env as Record<string, string> | undefined;
  if (!env) return;

  let changed = false;
  for (const key of keysToRemove) {
    if (key in env) {
      delete env[key];
      changed = true;
    }
  }
  if (!changed) return;

  existing.env = env;
  await writeFile(settingsPath, JSON.stringify(existing, null, 2) + '\n');
}

/**
 * Updates env vars in .claude/settings.local.json for the given case path.
 * Merges with existing env field; removes vars set to empty string.
 */
export async function updateCaseEnvVars(casePath: string, envVars: Record<string, string>): Promise<void> {
  const claudeDir = join(casePath, '.claude');
  if (!existsSync(claudeDir)) {
    await mkdir(claudeDir, { recursive: true });
  }

  const settingsPath = join(claudeDir, 'settings.local.json');
  let existing: Record<string, unknown> = {};

  try {
    existing = JSON.parse(await readFile(settingsPath, 'utf-8'));
  } catch {
    existing = {};
  }

  const currentEnv = (existing.env as Record<string, string>) || {};
  for (const [key, value] of Object.entries(envVars)) {
    if (value) {
      currentEnv[key] = value;
    } else {
      delete currentEnv[key];
    }
  }
  existing.env = currentEnv;

  await writeFile(settingsPath, JSON.stringify(existing, null, 2) + '\n');
}

/**
 * Updates the `model` field in .claude/settings.local.json for the given case path.
 * Pass a non-empty string to set, or empty/null to remove.
 */
export async function updateCaseModel(casePath: string, model: string | null): Promise<void> {
  const claudeDir = join(casePath, '.claude');
  if (!existsSync(claudeDir)) {
    await mkdir(claudeDir, { recursive: true });
  }

  const settingsPath = join(claudeDir, 'settings.local.json');
  let existing: Record<string, unknown> = {};

  try {
    existing = JSON.parse(await readFile(settingsPath, 'utf-8'));
  } catch {
    existing = {};
  }

  if (model) {
    existing.model = model;
  } else {
    delete existing.model;
  }

  await writeFile(settingsPath, JSON.stringify(existing, null, 2) + '\n');
}

/**
 * Writes hooks config to .claude/settings.local.json in the given case path.
 * Merges with existing file content, only touching the `hooks` key.
 */
export async function writeHooksConfig(casePath: string): Promise<void> {
  const claudeDir = join(casePath, '.claude');
  if (!existsSync(claudeDir)) {
    await mkdir(claudeDir, { recursive: true });
  }

  const settingsPath = join(claudeDir, 'settings.local.json');
  let existing: Record<string, unknown> = {};

  try {
    existing = JSON.parse(await readFile(settingsPath, 'utf-8'));
  } catch {
    // If file is malformed or doesn't exist, start fresh
    existing = {};
  }

  const hooksConfig = generateHooksConfig();
  const merged = { ...existing, ...hooksConfig };

  await writeFile(settingsPath, JSON.stringify(merged, null, 2) + '\n');
}
