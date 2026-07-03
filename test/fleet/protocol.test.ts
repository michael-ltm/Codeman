import { describe, it, expect } from 'vitest';
import {
  FLEET_PROTOCOL_VERSION,
  NodeToCentralFrameSchema,
  CentralToNodeFrameSchema,
  parseNodeToCentralFrame,
  parseCentralToNodeFrame,
  buildFleetSessionTab,
  ResumeCandidateSchema,
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

  it('round-trips the list-resume-candidates and list-dirs frames', () => {
    const rc = { t: 'list-resume-candidates', requestId: 'r1' };
    expect(parseCentralToNodeFrame(JSON.stringify(rc))).toEqual(rc);

    const ld = { t: 'list-dirs', requestId: 'r2', path: '/home/ming/projects' };
    expect(parseCentralToNodeFrame(JSON.stringify(ld))).toEqual(ld);

    // list-dirs requires a `path` string
    expect(CentralToNodeFrameSchema.safeParse({ t: 'list-dirs', requestId: 'r3' }).success).toBe(false);
  });

  it('accepts resumeSessionId on a create-session payload', () => {
    const frame = {
      t: 'create-session',
      requestId: 'r4',
      payload: { workingDir: '/tmp/proj', mode: 'claude', resumeSessionId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' },
    };
    const parsed = parseCentralToNodeFrame(JSON.stringify(frame));
    expect(parsed).toEqual(frame);
  });

  it('validates a ResumeCandidate shape', () => {
    const ok = { sessionId: 's1', workingDir: '/tmp', title: 'fix the thing', updatedAt: 123, projectKey: '-tmp' };
    expect(ResumeCandidateSchema.safeParse(ok).success).toBe(true);
    // projectKey is optional
    expect(
      ResumeCandidateSchema.safeParse({ sessionId: 's1', workingDir: '/tmp', title: 't', updatedAt: 1 }).success
    ).toBe(true);
    // title required
    expect(ResumeCandidateSchema.safeParse({ sessionId: 's1', workingDir: '/tmp', updatedAt: 1 }).success).toBe(false);
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
