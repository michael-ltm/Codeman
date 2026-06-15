/**
 * Tests for WorkflowRunWatcher — parses wf_<runId>.json run-state into
 * WorkflowRunInfo for the ultracode master-detail view.
 *
 * Drives the real discover→parse path against a synthetic on-disk fixture in a
 * temp projects dir (never the shared singleton, never ~/.claude).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkflowRunWatcher } from '../src/workflow-run-watcher.js';
import type { WorkflowRunInfo } from '../src/types/workflow-run.js';

const PROJECT_HASH = '-home-arkon-default-claudeman';
const SESSION_UUID = '388113c8-cd01-4e80-93a8-3be66ab1519b';
const RUN_ID = 'wf_test1234-abc';

/** A run JSON shaped like a real (killed) run: all three agent states + the bloat fields. */
function sampleRunJson() {
  return {
    runId: RUN_ID,
    timestamp: '2026-06-15T00:00:00.000Z',
    taskId: 'task_abc',
    // --- bloat fields that MUST be stripped ---
    script: 'export const meta = {};\n'.repeat(5000), // ~110KB
    scriptPath: '/tmp/whatever.js',
    result: { plan: { huge: 'object' } },
    logs: ['line1', 'line2'],
    // --- real fields ---
    agentCount: 3,
    durationMs: 795173,
    summary: 'Deep adversarial review of open PRs',
    workflowName: 'review-open-prs',
    status: 'killed',
    error: 'user stopped the task',
    startTime: 1781466999000,
    defaultModel: 'claude-opus-4-8[1m]',
    totalTokens: 109703,
    totalToolCalls: 44,
    phases: [
      { title: 'Review', detail: 'one deep reviewer per PR' },
      { title: 'Probe', detail: 'targeted security/correctness probes' },
      { title: 'Verify', detail: 'adversarially verify each finding' },
    ],
    workflowProgress: [
      { type: 'workflow_phase', index: 0, phaseIndex: 1, phaseTitle: 'Review' },
      {
        type: 'workflow_agent',
        index: 1,
        label: 'probe:dompurify-config',
        phaseIndex: 2,
        phaseTitle: 'Probe',
        agentId: 'a6c0e282c3f5ac0bf',
        model: 'claude-opus-4-8[1m]',
        state: 'done',
        startedAt: 1781467000002,
        queuedAt: 1781466999962,
        attempt: 1,
        lastToolName: 'StructuredOutput',
        lastToolSummary: 'Does the profile setting make the allowlist dead config',
        promptPreview: 'You are reviewing a pull request...',
        lastProgressAt: 1781467524143,
        tokens: 104703,
        toolCalls: 41,
        durationMs: 524140,
        resultPreview: '{"verdict":"concern"}',
      },
      {
        type: 'workflow_agent',
        index: 2,
        label: 'review:pr-127',
        phaseIndex: 1,
        phaseTitle: 'Review',
        agentId: 'a1234567890abcdef',
        model: 'claude-opus-4-8[1m]',
        state: 'progress',
        startedAt: 1781467010000,
        queuedAt: 1781466999970,
        attempt: 1,
        lastToolName: 'Read',
        promptPreview: 'Review PR 127...',
        lastProgressAt: 1781467600000,
        tokens: 5000,
        toolCalls: 3,
      },
      {
        type: 'workflow_agent',
        index: 3,
        label: 'verify:finding-x',
        phaseIndex: 3,
        phaseTitle: 'Verify',
        model: 'claude-opus-4-8[1m]',
        state: 'start',
        queuedAt: 1781466999980,
        promptPreview: 'Verify finding x...',
        lastProgressAt: 1781466999980,
      },
    ],
  };
}

describe('WorkflowRunWatcher', () => {
  let projectsDir: string;
  let watcher: WorkflowRunWatcher;

  beforeEach(async () => {
    projectsDir = await mkdtemp(join(tmpdir(), 'wfw-test-'));
    const workflowsDir = join(projectsDir, PROJECT_HASH, SESSION_UUID, 'workflows');
    await mkdir(workflowsDir, { recursive: true });
    await writeFile(join(workflowsDir, `${RUN_ID}.json`), JSON.stringify(sampleRunJson()), 'utf-8');
    watcher = new WorkflowRunWatcher(projectsDir);
  });

  afterEach(async () => {
    watcher.stop();
    await rm(projectsDir, { recursive: true, force: true });
  });

  /** Start the watcher and resolve with the first discovered run. */
  function firstRun(): Promise<WorkflowRunInfo> {
    return new Promise<WorkflowRunInfo>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for run_discovered')), 5000);
      watcher.once('run_discovered', (info: WorkflowRunInfo) => {
        clearTimeout(timer);
        resolve(info);
      });
      watcher.start();
    });
  }

  it('discovers and parses a run, deriving session/project from the path', async () => {
    const info = await firstRun();
    expect(info.runId).toBe(RUN_ID);
    expect(info.workflowName).toBe('review-open-prs');
    expect(info.status).toBe('killed');
    expect(info.error).toBe('user stopped the task');
    expect(info.sessionUuid).toBe(SESSION_UUID);
    expect(info.projectHash).toBe(PROJECT_HASH);
    expect(info.totalTokens).toBe(109703);
    expect(info.totalToolCalls).toBe(44);
  });

  it('keeps only workflow_agent entries (drops workflow_phase markers)', async () => {
    const info = await firstRun();
    expect(info.agents).toHaveLength(3);
    expect(info.phases).toHaveLength(3);
  });

  it('STRIPS the heavyweight script/scriptPath/result/logs fields', async () => {
    const info = await firstRun();
    const asAny = info as unknown as Record<string, unknown>;
    expect('script' in asAny).toBe(false);
    expect('scriptPath' in asAny).toBe(false);
    expect('result' in asAny).toBe(false);
    expect('logs' in asAny).toBe(false);
    // The serialized run that reaches a client must be small.
    expect(JSON.stringify(info).length).toBeLessThan(5000);
  });

  it('carries tokens/toolCalls/durationMs on a done agent', async () => {
    const info = await firstRun();
    const done = info.agents.find((a) => a.state === 'done')!;
    expect(done.agentId).toBe('a6c0e282c3f5ac0bf');
    expect(done.tokens).toBe(104703);
    expect(done.toolCalls).toBe(41);
    expect(done.durationMs).toBe(524140);
    expect(done.resultPreview).toBeDefined();
  });

  it('omits agentId/tokens/toolCalls/durationMs on a start (queued) agent', async () => {
    const info = await firstRun();
    const queued = info.agents.find((a) => a.state === 'start')!;
    expect(queued.agentId).toBeUndefined();
    expect(queued.tokens).toBeUndefined();
    expect(queued.toolCalls).toBeUndefined();
    expect(queued.durationMs).toBeUndefined();
    expect(queued.label).toBe('verify:finding-x');
  });

  it('a progress agent has tokens but no durationMs (live discriminator)', async () => {
    const info = await firstRun();
    const running = info.agents.find((a) => a.state === 'progress')!;
    expect(running.tokens).toBe(5000);
    expect(running.toolCalls).toBe(3);
    expect(running.durationMs).toBeUndefined();
  });

  it('phase join: agent.phaseIndex-1 indexes run.phases', async () => {
    const info = await firstRun();
    for (const agent of info.agents) {
      expect(info.phases[agent.phaseIndex - 1].title).toBe(agent.phaseTitle);
    }
  });

  it('exposes the run via getAllRuns/getRun after discovery', async () => {
    await firstRun();
    expect(watcher.getAllRuns()).toHaveLength(1);
    expect(watcher.getRun(RUN_ID)?.runId).toBe(RUN_ID);
    expect(watcher.getStats().agentCount).toBe(3);
  });

  it('getRecentRunSummaries omits agents[] (lightweight snapshot)', async () => {
    await firstRun();
    const summaries = watcher.getRecentRunSummaries(100000);
    expect(summaries).toHaveLength(1);
    expect('agents' in summaries[0]).toBe(false);
    expect(summaries[0].runId).toBe(RUN_ID);
    expect(summaries[0].agentCount).toBe(3);
  });
});

/**
 * In-flight runs: the Workflow runtime writes the completion wf_<id>.json only when
 * a run FINISHES, so while it is live the only on-disk state is its
 * subagents/workflows/wf_<id>/ transcript dir. The watcher synthesizes a minimal
 * ACTIVE run from that dir so the floating window pops DURING the run.
 */
describe('WorkflowRunWatcher — in-flight (live) runs', () => {
  const LIVE_RUN_ID = 'wf_live5678-xyz';
  let projectsDir: string;
  let liveDir: string;
  let watcher: WorkflowRunWatcher;

  beforeEach(async () => {
    projectsDir = await mkdtemp(join(tmpdir(), 'wfw-live-'));
    liveDir = join(projectsDir, PROJECT_HASH, SESSION_UUID, 'subagents', 'workflows', LIVE_RUN_ID);
    await mkdir(liveDir, { recursive: true });
    // Two agents started; one already produced a result (journal `result` line).
    await writeFile(
      join(liveDir, 'agent-aaa111.meta.json'),
      JSON.stringify({ agentType: 'workflow-subagent' }),
      'utf-8'
    );
    await writeFile(join(liveDir, 'agent-aaa111.jsonl'), '{"type":"assistant"}\n', 'utf-8');
    await writeFile(
      join(liveDir, 'agent-bbb222.meta.json'),
      JSON.stringify({ agentType: 'workflow-subagent' }),
      'utf-8'
    );
    await writeFile(join(liveDir, 'agent-bbb222.jsonl'), '{"type":"assistant"}\n', 'utf-8');
    await writeFile(
      join(liveDir, 'journal.jsonl'),
      '{"type":"started","agentId":"aaa111"}\n{"type":"started","agentId":"bbb222"}\n{"type":"result","agentId":"aaa111","result":{}}\n',
      'utf-8'
    );
    watcher = new WorkflowRunWatcher(projectsDir);
  });

  afterEach(async () => {
    watcher.stop();
    await rm(projectsDir, { recursive: true, force: true });
  });

  function firstRun(): Promise<WorkflowRunInfo> {
    return new Promise<WorkflowRunInfo>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for run_discovered')), 5000);
      watcher.once('run_discovered', (info: WorkflowRunInfo) => {
        clearTimeout(timer);
        resolve(info);
      });
      watcher.start();
    });
  }

  it('synthesizes an ACTIVE run from the transcript dir when no completion file exists', async () => {
    const info = await firstRun();
    expect(info.runId).toBe(LIVE_RUN_ID);
    expect(info.status).toBe('running'); // active → frontend pops a floating window
    expect(info.sessionUuid).toBe(SESSION_UUID);
    expect(info.projectHash).toBe(PROJECT_HASH);
    expect(info.agents).toHaveLength(2);
    expect(info.agentCount).toBe(2);
    expect(info.lastActivityAt).toBeGreaterThan(0);
  });

  it('preserves agentId per slot (so the card→transcript click join still works)', async () => {
    const info = await firstRun();
    const ids = info.agents.map((a) => a.agentId).sort();
    expect(ids).toEqual(['aaa111', 'bbb222']);
  });

  it('marks an agent done/progress from journal result lines', async () => {
    const info = await firstRun();
    expect(info.agents.find((a) => a.agentId === 'aaa111')!.state).toBe('done'); // has a result line
    expect(info.agents.find((a) => a.agentId === 'bbb222')!.state).toBe('progress'); // started, no result yet
  });

  it('counts the live run as running in getStats', async () => {
    await firstRun();
    expect(watcher.getStats().running).toBe(1);
  });

  it('does NOT surface a live dir that has no agent files yet', async () => {
    const empty = join(projectsDir, PROJECT_HASH, SESSION_UUID, 'subagents', 'workflows', 'wf_empty0000-noo');
    await mkdir(empty, { recursive: true });
    await firstRun(); // resolves on the real (populated) live run
    // The empty run id must never enter the cache.
    expect(watcher.getRun('wf_empty0000-noo')).toBeUndefined();
    expect(watcher.getAllRuns().map((r) => r.runId)).toEqual([LIVE_RUN_ID]);
  });

  it('a completion wf_*.json supersedes the live dir for the same runId (real status wins)', async () => {
    const workflowsDir = join(projectsDir, PROJECT_HASH, SESSION_UUID, 'workflows');
    await mkdir(workflowsDir, { recursive: true });
    await writeFile(
      join(workflowsDir, `${LIVE_RUN_ID}.json`),
      JSON.stringify({ runId: LIVE_RUN_ID, status: 'completed', durationMs: 1234, phases: [], workflowProgress: [] }),
      'utf-8'
    );
    const info = await firstRun();
    expect(info.runId).toBe(LIVE_RUN_ID);
    expect(info.status).toBe('completed'); // real completion file wins, not synthesized 'running'
    expect(info.durationMs).toBe(1234);
    // Only one cached entry for the runId — no live/real duplication.
    expect(watcher.getAllRuns()).toHaveLength(1);
  });
});
