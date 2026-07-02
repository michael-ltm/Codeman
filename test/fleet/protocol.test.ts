import { describe, it, expect } from 'vitest';
import {
  FLEET_PROTOCOL_VERSION,
  NodeToCentralFrameSchema,
  CentralToNodeFrameSchema,
  parseNodeToCentralFrame,
  parseCentralToNodeFrame,
  buildFleetSessionTab,
} from '../../src/fleet/protocol.js';

const device = {
  id: 'dev_1',
  name: 'macmini',
  hostname: 'macmini.local',
  platform: 'darwin',
  arch: 'arm64',
  username: 'ming',
  version: '1.2.2',
  status: 'online' as const,
  lastSeenAt: 1,
  activeSessionCount: 1,
  capabilities: { tmux: true, claude: true, codex: true, shell: true },
};
const session = {
  deviceId: 'dev_1',
  id: 's1',
  name: 'codex',
  mode: 'codex' as const,
  status: 'busy' as const,
  workingDir: '/tmp/proj',
  pid: 123,
  createdAt: 1,
  lastActivityAt: 2,
};

describe('fleet protocol', () => {
  it('exports protocol version 1', () => expect(FLEET_PROTOCOL_VERSION).toBe(1));

  it('round-trips a valid hello frame', () => {
    const frame = { t: 'hello', protocol: 1, device, sessions: [session] };
    expect(parseNodeToCentralFrame(JSON.stringify(frame))).toEqual(frame);
  });

  it('rejects unknown frame type and bad JSON', () => {
    expect(parseNodeToCentralFrame(JSON.stringify({ t: 'nope' }))).toBeNull();
    expect(parseNodeToCentralFrame('{oops')).toBeNull();
  });

  it('validates central frames incl. optional seq/cid input', () => {
    const input = { t: 'terminal:input', sessionId: 's1', data: 'ls\n', seq: 3, cid: 'b1' };
    expect(parseCentralToNodeFrame(JSON.stringify(input))).toEqual(input);
    expect(CentralToNodeFrameSchema.safeParse({ t: 'get-buffer', requestId: 'r1', sessionId: 's1' }).success).toBe(
      true
    );
    expect(CentralToNodeFrameSchema.safeParse({ t: 'create-session', requestId: 'r1', payload: {} }).success).toBe(
      false
    ); // workingDir 必填
  });

  it('builds tab with key/device-name/label/title rules', () => {
    const tab = buildFleetSessionTab(device, session);
    expect(tab.key).toBe('dev_1:s1');
    expect(tab.title).toBe('macmini / codex');
    // 无 name 时回退 basename(workingDir),再回退 id 前 8 位
    const t2 = buildFleetSessionTab({ ...device, name: '' }, { ...session, name: undefined });
    expect(t2.deviceName).toBe('macmini.local');
    expect(t2.sessionLabel).toBe('proj');
    expect(t2.title).toBe('macmini.local / proj');
  });
});
