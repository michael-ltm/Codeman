/**
 * @fileoverview Fleet node config — local pairing state + `codeman node join`.
 *
 * A node device (e.g. a macmini) persists its central URL, assigned device ID,
 * and auth token in `~/.codeman/fleet-node.json` (0600 perms) after pairing
 * with a central controller via a one-time code. This file is read by the
 * node agent (Task 10) on startup to reconnect without re-pairing.
 *
 * Key exports:
 * - FleetNodeConfig — the persisted shape
 * - fleetNodeConfigPath / readFleetNodeConfig / writeFleetNodeConfig — file I/O
 * - collectDeviceJoinInfo — gathers host facts + capability probes for pairing
 * - joinFleet — POSTs a pairing code to the central controller and persists
 *   the resulting device identity
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { hostname, userInfo } from 'node:os';
import { createRequire } from 'node:module';
import { dataPath } from '../config/instance.js';
import { TmuxManager } from '../tmux-manager.js';
import { findClaudeDir } from '../utils/claude-cli-resolver.js';
import { isCodexAvailable } from '../utils/codex-cli-resolver.js';
import type { FleetCapabilities, FleetDeviceJoinInfo } from './protocol.js';

const require = createRequire(import.meta.url);

/** Local pairing state persisted after a successful `codeman node join`. */
export interface FleetNodeConfig {
  centralUrl: string;
  deviceId: string;
  token: string;
  deviceName: string;
  joinedAt: number;
}

/** Default path for the node config file: `~/.codeman/fleet-node.json`. */
export function fleetNodeConfigPath(): string {
  return dataPath('fleet-node.json');
}

/** Read the node config from disk; returns null if missing or unreadable. */
export function readFleetNodeConfig(filePath: string = fleetNodeConfigPath()): FleetNodeConfig | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as FleetNodeConfig;
  } catch {
    return null;
  }
}

/** Write the node config to disk, creating parent dirs and locking perms to 0600 (POSIX). */
export function writeFleetNodeConfig(config: FleetNodeConfig, filePath: string = fleetNodeConfigPath()): void {
  mkdirSync(dirname(filePath), { recursive: true });
  // `mode` locks perms at creation so the token is never briefly world-readable
  // for a NEW file. It's ignored when the file already exists, so the chmod
  // below still re-locks the overwrite case (an earlier looser-perms file).
  writeFileSync(filePath, JSON.stringify(config, null, 2), { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(filePath, 0o600);
}

/** Read this package's version the same way cli.ts does for `--version`. */
function readPackageVersion(): string {
  const pkg = require('../../package.json') as { version: string };
  return pkg.version;
}

/** Probe which CLI backends / features this machine supports. */
function detectCapabilities(): FleetCapabilities {
  return {
    tmux: TmuxManager.isTmuxAvailable(),
    claude: findClaudeDir() !== null,
    codex: isCodexAvailable(),
    shell: true,
  };
}

/** Gather this device's static identity + capabilities for the `hello`/pairing handshake. */
export function collectDeviceJoinInfo(name?: string): FleetDeviceJoinInfo {
  const host = hostname();
  return {
    name: name || host,
    hostname: host,
    platform: process.platform,
    arch: process.arch,
    username: userInfo().username,
    version: readPackageVersion(),
    capabilities: detectCapabilities(),
  };
}

/**
 * Pair this device with a central controller: POST the one-time code + device
 * facts to `/api/fleet/pair`, unwrap the `{success,data|error}` envelope, and
 * persist the resulting device identity to `filePath` (default: fleetNodeConfigPath()).
 */
export async function joinFleet(
  centralUrl: string,
  code: string,
  name?: string,
  filePath?: string
): Promise<FleetNodeConfig> {
  const device = collectDeviceJoinInfo(name);
  const res = await fetch(`${centralUrl.replace(/\/$/, '')}/api/fleet/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, device }),
  });
  const body = (await res.json()) as { success: boolean; data?: { deviceId: string; token: string }; error?: string };
  if (!res.ok || !body.success || !body.data) {
    throw new Error(body.error || `Pairing failed (HTTP ${res.status})`);
  }
  const config: FleetNodeConfig = {
    centralUrl,
    deviceId: body.data.deviceId,
    token: body.data.token,
    deviceName: device.name,
    joinedAt: Date.now(),
  };
  writeFleetNodeConfig(config, filePath);
  return config;
}
