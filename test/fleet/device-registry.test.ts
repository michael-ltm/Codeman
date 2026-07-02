import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceRegistry } from '../../src/fleet/device-registry.js';

const joinInfo = {
  name: 'macbook',
  hostname: 'mb.local',
  platform: 'darwin',
  arch: 'arm64',
  username: 'ming',
  version: '1.2.2',
  capabilities: { tmux: true, claude: true, codex: false, shell: true },
};

describe('DeviceRegistry', () => {
  let file: string;
  let reg: DeviceRegistry;
  beforeEach(() => {
    file = join(mkdtempSync(join(tmpdir(), 'fleet-reg-')), 'fleet-devices.json');
    reg = new DeviceRegistry(file);
  });

  it('pairing code: 8 chars, no confusing chars, single-use, 10min expiry', () => {
    const { code, expiresAt } = reg.createPairingCode(1000);
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(expiresAt).toBe(1000 + 10 * 60 * 1000);
    const { deviceId, token } = reg.consumePairingCode(code, joinInfo, 2000);
    expect(deviceId).toMatch(/^dev_/);
    expect(token.length).toBeGreaterThanOrEqual(43); // 32 bytes base64url
    expect(() => reg.consumePairingCode(code, joinInfo, 3000)).toThrow(/invalid or expired/i); // 一次性
  });

  it('expired code fails', () => {
    const { code } = reg.createPairingCode(1000);
    expect(() => reg.consumePairingCode(code, joinInfo, 1000 + 10 * 60 * 1000 + 1)).toThrow(/invalid or expired/i);
  });

  it('authenticates correct token only; plaintext token never persisted', () => {
    const { code } = reg.createPairingCode(1000);
    const { deviceId, token } = reg.consumePairingCode(code, joinInfo, 2000);
    expect(reg.authenticate(deviceId, token)).toBe(true);
    expect(reg.authenticate(deviceId, token + 'x')).toBe(false);
    expect(reg.authenticate('dev_nope', token)).toBe(false);
    reg.saveNow();
    const raw = readFileSync(file, 'utf8');
    expect(raw.includes(token)).toBe(false); // 只存 SHA-256
  });

  it('markOffline keeps device with offline status; reload from disk works', () => {
    const { code } = reg.createPairingCode(1000);
    const { deviceId } = reg.consumePairingCode(code, joinInfo, 2000);
    reg.markOnline(deviceId, 3000);
    expect(reg.getDevice(deviceId)?.status).toBe('online');
    reg.markOffline(deviceId, 4000);
    const d = reg.getDevice(deviceId)!;
    expect(d.status).toBe('offline');
    expect(d.lastSeenAt).toBe(4000);
    reg.saveNow();
    const reloaded = new DeviceRegistry(file);
    expect(reloaded.listDevices().map((x) => x.id)).toEqual([deviceId]);
    expect(reloaded.getDevice(deviceId)?.status).toBe('offline'); // 重启后一律 offline
  });

  it('tolerates corrupted fleet-devices.json; falls back to empty state', () => {
    // Write garbage to the registry file
    writeFileSync(file, '{oops');
    // Should not throw; should initialize with empty state
    const reg2 = new DeviceRegistry(file);
    expect(reg2.listDevices()).toEqual([]);
  });
});
