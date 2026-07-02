import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readFleetNodeConfig,
  writeFleetNodeConfig,
  joinFleet,
  collectDeviceJoinInfo,
} from '../../src/fleet/node-config.js';

const cfg = {
  centralUrl: 'http://100.93.252.18:3100',
  deviceId: 'dev_a',
  token: 'tok',
  deviceName: 'macbook',
  joinedAt: 1,
};

describe('fleet node config', () => {
  afterEach(() => vi.restoreAllMocks());

  it('write/read round-trip with 0600 perms; missing file → null', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'fleet-node-')), 'fleet-node.json');
    expect(readFleetNodeConfig(file)).toBeNull();
    writeFleetNodeConfig(cfg, file);
    expect(readFleetNodeConfig(file)).toEqual(cfg);
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it('collectDeviceJoinInfo fills host facts and capabilities', () => {
    const info = collectDeviceJoinInfo('macbook');
    expect(info.name).toBe('macbook');
    expect(info.platform).toBe(process.platform);
    expect(typeof info.capabilities.tmux).toBe('boolean');
  });

  it('joinFleet POSTs code+device, unwraps {success,data} envelope, writes config', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'fleet-node-')), 'fleet-node.json');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe('http://central:3100/api/fleet/pair');
        const body = JSON.parse(String(init.body));
        expect(body.code).toBe('ABCD2345');
        expect(body.device.name).toBe('macbook');
        return new Response(JSON.stringify({ success: true, data: { deviceId: 'dev_x', token: 'tok_y' } }), {
          status: 200,
        });
      })
    );
    const out = await joinFleet('http://central:3100', 'ABCD2345', 'macbook', file);
    expect(out.deviceId).toBe('dev_x');
    expect(JSON.parse(readFileSync(file, 'utf8')).token).toBe('tok_y');
  });

  it('joinFleet surfaces server error message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ success: false, error: 'Pairing code invalid or expired' }), { status: 400 })
      )
    );
    await expect(joinFleet('http://central:3100', 'BAD', 'x', '/dev/null')).rejects.toThrow(/invalid or expired/i);
  });
});
