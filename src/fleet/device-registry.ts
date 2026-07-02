import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dataPath } from '../config/instance.js';
import type { FleetDeviceJoinInfo, FleetDeviceSummary } from './protocol.js';

const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 排除 0 O 1 I
const PAIRING_CODE_LENGTH = 8;
const PAIRING_TTL_MS = 10 * 60 * 1000;

interface StoredDevice extends FleetDeviceJoinInfo {
  id: string;
  tokenHash: string;
  createdAt: number;
  lastSeenAt: number;
}
interface StoredFile {
  devices: Record<string, StoredDevice>;
  pairingCodes: Record<string, { expiresAt: number }>;
}

export class DeviceRegistry {
  private file: StoredFile = { devices: {}, pairingCodes: {} };
  private online = new Set<string>();
  constructor(private filePath: string = dataPath('fleet-devices.json')) {
    if (existsSync(filePath)) {
      try {
        const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<StoredFile>;
        // Guard against missing required keys; merge with defaults
        this.file = {
          devices: parsed.devices ?? {},
          pairingCodes: parsed.pairingCodes ?? {},
        };
      } catch (err) {
        console.warn(`[DeviceRegistry] Failed to load fleet-devices.json; falling back to empty state:`, err);
      }
    }
  }
  createPairingCode(now = Date.now()) {
    const bytes = randomBytes(PAIRING_CODE_LENGTH);
    let code = '';
    for (let i = 0; i < PAIRING_CODE_LENGTH; i++) code += PAIRING_ALPHABET[bytes[i] % PAIRING_ALPHABET.length];
    const expiresAt = now + PAIRING_TTL_MS;
    this.file.pairingCodes[code] = { expiresAt };
    this.saveNow();
    return { code, expiresAt };
  }
  consumePairingCode(code: string, device: FleetDeviceJoinInfo, now = Date.now()) {
    const entry = this.file.pairingCodes[code];
    delete this.file.pairingCodes[code]; // 无论成败都作废
    if (!entry || entry.expiresAt < now) {
      this.saveNow();
      throw new Error('Pairing code invalid or expired');
    }
    const deviceId = `dev_${randomBytes(6).toString('hex')}`;
    const token = randomBytes(32).toString('base64url');
    this.file.devices[deviceId] = {
      ...device,
      id: deviceId,
      tokenHash: sha256(token),
      createdAt: now,
      lastSeenAt: now,
    };
    this.saveNow();
    return { deviceId, token };
  }
  authenticate(deviceId: string, token: string): boolean {
    const d = this.file.devices[deviceId];
    return !!d && d.tokenHash === sha256(token); // 哈希等长,直接比较即可
  }
  markOnline(deviceId: string, now = Date.now()) {
    this.online.add(deviceId);
    this.touch(deviceId, now);
  }
  markOffline(deviceId: string, now = Date.now()) {
    this.online.delete(deviceId);
    this.touch(deviceId, now);
  }
  getDevice(deviceId: string): FleetDeviceSummary | null {
    const d = this.file.devices[deviceId];
    return d ? this.toSummary(d) : null;
  }
  listDevices(): FleetDeviceSummary[] {
    return Object.values(this.file.devices).map((d) => this.toSummary(d));
  }
  saveNow() {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.file, null, 2));
    renameSync(tmp, this.filePath); // 原子写
  }
  private touch(deviceId: string, now: number) {
    const d = this.file.devices[deviceId];
    if (d) {
      d.lastSeenAt = now;
      this.saveNow();
    }
  }
  private toSummary(d: StoredDevice): FleetDeviceSummary {
    const { tokenHash: _t, createdAt: _c, ...rest } = d;
    return { ...rest, status: this.online.has(d.id) ? 'online' : 'offline', activeSessionCount: 0 };
  }
}
function sha256(s: string) {
  return createHash('sha256').update(s).digest('hex');
}
