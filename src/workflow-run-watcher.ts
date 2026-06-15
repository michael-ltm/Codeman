/**
 * @fileoverview Workflow (ultracode) Run Watcher
 *
 * Emits events powering the master-detail "working agents" view (tasks/phases on
 * the LEFT, per-agent tokens/tool-calls on the RIGHT) AND the floating run
 * windows, from TWO disk sources per run:
 *
 *   1. COMPLETION artifact — `…/workflows/wf_<id>.json`. The Workflow runtime
 *      writes this with the FULL run state (phases, per-agent tokens/tool-calls,
 *      result), but — as of the mid-2026 runtime — only when the run FINISHES
 *      (always a terminal status). It is the authoritative, detailed record.
 *   2. LIVE transcript dir — `…/subagents/workflows/wf_<id>/` (agent-*.jsonl +
 *      journal.jsonl). This appears WHILE a run is in flight, before any
 *      `wf_<id>.json` exists. From it we synthesize a minimal ACTIVE run
 *      (status 'running', agent slots keyed by agentId, lastActivityAt from file
 *      mtimes) so the floating window pops DURING the run instead of only after.
 *
 * Precedence: when a completion `wf_<id>.json` exists it ALWAYS supersedes the
 * synthesized live record (same runId), so a finished run shows full detail and
 * the normal finish→auto-close flow runs. Without source 2 the floating-window
 * feature is dead for live runs (the completion file only lands at the end, so
 * the watcher would never see a run while it is active).
 *
 * Still STANDALONE: it never imports from or touches subagent-watcher.ts. It
 * independently reads the same `subagents/workflows/` tree subagent-watcher uses,
 * but as a separate singleton with no shared mutable state.
 *
 * Discovery is dual: a periodic poll (catches new run dirs + removals) plus a
 * per-dir chokidar watcher (live updates). A per-source mtime skip keeps the hot
 * path cheap — the completion JSON / live dir is re-read only when its mtime moves.
 *
 * @module workflow-run-watcher
 */

import { EventEmitter } from 'node:events';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { watch as chokidarWatch, type FSWatcher as ChokidarWatcher } from 'chokidar';

import type { WorkflowRunInfo, WorkflowRunSummary, WorkflowAgentInfo, WorkflowRunPhase } from './types/workflow-run.js';
import { LRUMap } from './utils/lru-map.js';
import {
  WORKFLOW_RUN_POLL_INTERVAL_MS,
  MAX_CACHED_WORKFLOW_RUNS,
  WORKFLOW_RUN_RECENT_WINDOW_MIN,
} from './config/workflow-config.js';

const WORKFLOWS_SUBDIR = 'workflows';
const SUBAGENTS_SUBDIR = 'subagents';
const RUN_FILE_PREFIX = 'wf_';
const RUN_FILE_SUFFIX = '.json';
const LIVE_JOURNAL_FILE = 'journal.jsonl';
const LIVE_AGENT_PREFIX = 'agent-';

/** Hard caps on the largest per-agent strings so a 28-agent run stays compact. */
const PROMPT_PREVIEW_MAX = 200;
const RESULT_PREVIEW_MAX = 240;

function truncate(value: string | undefined, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Drop the heavy `agents[]` for list/snapshot use. */
export function summarizeRun(info: WorkflowRunInfo): WorkflowRunSummary {
  const { agents: _agents, ...summary } = info;
  void _agents;
  return summary;
}

interface DiscoveredRun {
  filePath: string;
  projectHash: string;
  sessionUuid: string;
  runId: string;
}

/** An in-flight run discovered from its `subagents/workflows/wf_<id>/` transcript dir. */
interface DiscoveredLiveRun {
  dirPath: string;
  projectHash: string;
  sessionUuid: string;
  runId: string;
}

/** A `workflowProgress[]` entry as it appears on disk (loosely typed for defensive parsing). */
interface RawProgressEntry {
  type?: string;
  index?: number;
  label?: string;
  phaseIndex?: number;
  phaseTitle?: string;
  model?: string;
  state?: string;
  queuedAt?: number;
  lastProgressAt?: number;
  promptPreview?: string;
  agentId?: string;
  startedAt?: number;
  attempt?: number;
  tokens?: number;
  toolCalls?: number;
  lastToolName?: string;
  lastToolSummary?: string;
  durationMs?: number;
  resultPreview?: string;
}

export class WorkflowRunWatcher extends EventEmitter {
  private projectsDir: string;
  private pollTimer: NodeJS.Timeout | null = null;
  private _isRunning = false;

  /** runId -> latest parsed run info (LRU-bounded). */
  private runs = new LRUMap<string, WorkflowRunInfo>({ maxSize: MAX_CACHED_WORKFLOW_RUNS });
  /** absolute run-file path -> last seen mtimeMs (skip unchanged files). */
  private fileMtimes = new Map<string, number>();
  /** runId -> absolute run-file path (for mtime cleanup on removal). */
  private runIdToPath = new Map<string, string>();
  /** absolute live transcript-dir path -> newest member mtimeMs (skip unchanged live runs). */
  private liveDirMtimes = new Map<string, number>();
  /** runId -> absolute live transcript-dir path (for mtime cleanup on removal). */
  private runIdToLiveDir = new Map<string, string>();
  /** watched-dir absolute path -> chokidar watcher (workflows/ + subagents/workflows/). */
  private dirWatchers = new Map<string, ChokidarWatcher>();

  constructor(projectsDir?: string) {
    super();
    this.projectsDir = projectsDir || join(homedir(), '.claude', 'projects');
    this.setMaxListeners(50);
  }

  // ========== Public API ==========

  isRunning(): boolean {
    return this._isRunning;
  }

  start(): void {
    if (this._isRunning) return;
    this._isRunning = true;
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), WORKFLOW_RUN_POLL_INTERVAL_MS);
  }

  stop(): void {
    this._isRunning = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const watcher of this.dirWatchers.values()) {
      watcher.close().catch(() => {}); // best-effort teardown
    }
    this.dirWatchers.clear();
    this.runs.clear();
    this.fileMtimes.clear();
    this.runIdToPath.clear();
    this.liveDirMtimes.clear();
    this.runIdToLiveDir.clear();
  }

  /** All cached runs (no recency filter), most-recently-active first. */
  getAllRuns(): WorkflowRunInfo[] {
    return Array.from(this.runs.values()).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  /** Runs active within the last `minutes`, most-recently-active first. */
  getRecentRuns(minutes: number = WORKFLOW_RUN_RECENT_WINDOW_MIN): WorkflowRunInfo[] {
    const cutoff = Date.now() - minutes * 60_000;
    return this.getAllRuns().filter((r) => r.lastActivityAt >= cutoff);
  }

  /**
   * Lightweight summaries (no agents[]) of ALL cached runs, most-recently-active
   * first. This is the LEFT-pane list + getLightState snapshot source: the cache
   * is LRU-bounded (MAX_CACHED_WORKFLOW_RUNS), so it's already size-capped, and a
   * run-browser should show past runs — NOT hide everything older than a window.
   */
  getAllRunSummaries(): WorkflowRunSummary[] {
    return this.getAllRuns().map(summarizeRun);
  }

  /** Summaries filtered to the last `minutes` of activity (opt-in via ?minutes). */
  getRecentRunSummaries(minutes: number = WORKFLOW_RUN_RECENT_WINDOW_MIN): WorkflowRunSummary[] {
    return this.getRecentRuns(minutes).map(summarizeRun);
  }

  getRun(runId: string): WorkflowRunInfo | undefined {
    return this.runs.get(runId);
  }

  getStats(): { runCount: number; running: number; agentCount: number } {
    let running = 0;
    let agentCount = 0;
    for (const run of this.runs.values()) {
      if (run.status === 'running') running++;
      agentCount += run.agents.length;
    }
    return { runCount: this.runs.size, running, agentCount };
  }

  // ========== Private ==========

  private poll(): void {
    this.pollAsync().catch(() => {
      // Filesystem may be transiently unavailable; the next poll retries.
    });
  }

  private async pollAsync(): Promise<void> {
    const { files, liveDirs, watchDirs } = await this.discover();

    // Install a live watcher for each watched dir; tear down watchers for dirs that vanished.
    for (const dir of watchDirs) this.ensureDirWatcher(dir);
    for (const dir of Array.from(this.dirWatchers.keys())) {
      if (!watchDirs.has(dir)) this.removeDirWatcher(dir);
    }

    const seenRunIds = new Set<string>();
    const realRunIds = new Set<string>();
    for (const file of files) {
      seenRunIds.add(file.runId);
      realRunIds.add(file.runId);
      await this.maybeParse(file);
    }

    // In-flight runs: synthesize from the transcript tree ONLY while no completion
    // wf_*.json exists yet — the real file (full detail + terminal status) supersedes.
    for (const live of liveDirs) {
      if (realRunIds.has(live.runId)) continue;
      seenRunIds.add(live.runId);
      await this.maybeParseLive(live);
    }

    // Removal by set-diff: a cached run discoverable from neither source.
    for (const runId of Array.from(this.runs.keys())) {
      if (!seenRunIds.has(runId)) {
        this.runs.delete(runId);
        const path = this.runIdToPath.get(runId);
        if (path) this.fileMtimes.delete(path);
        this.runIdToPath.delete(runId);
        const liveDir = this.runIdToLiveDir.get(runId);
        if (liveDir) this.liveDirMtimes.delete(liveDir);
        this.runIdToLiveDir.delete(runId);
        this.emit('run_removed', { runId });
      }
    }
  }

  /**
   * Walk projects/<projHash>/<sessionUuid>/ for both run sources:
   *   - completion files: `workflows/wf_*.json`
   *   - in-flight runs:   `subagents/workflows/wf_<id>/` (transcript dirs)
   * Returns the dirs to chokidar-watch (so a new run/file is caught sub-poll).
   */
  private async discover(): Promise<{
    files: DiscoveredRun[];
    liveDirs: DiscoveredLiveRun[];
    watchDirs: Set<string>;
  }> {
    const files: DiscoveredRun[] = [];
    const liveDirs: DiscoveredLiveRun[] = [];
    const watchDirs = new Set<string>();

    let projectHashes: string[];
    try {
      projectHashes = await readdir(this.projectsDir);
    } catch {
      return { files, liveDirs, watchDirs };
    }

    for (const projectHash of projectHashes) {
      let sessions: string[];
      try {
        sessions = await readdir(join(this.projectsDir, projectHash));
      } catch {
        continue;
      }
      for (const sessionUuid of sessions) {
        const sessionDir = join(this.projectsDir, projectHash, sessionUuid);

        // (1) Completion artifacts: workflows/wf_*.json
        const workflowsDir = join(sessionDir, WORKFLOWS_SUBDIR);
        try {
          const names = await readdir(workflowsDir);
          let hasRun = false;
          for (const name of names) {
            if (!name.startsWith(RUN_FILE_PREFIX) || !name.endsWith(RUN_FILE_SUFFIX)) continue;
            hasRun = true;
            files.push({
              filePath: join(workflowsDir, name),
              projectHash,
              sessionUuid,
              runId: name.slice(0, -RUN_FILE_SUFFIX.length),
            });
          }
          if (hasRun) watchDirs.add(workflowsDir);
        } catch {
          // no workflows dir for this session — normal
        }

        // (2) In-flight runs: subagents/workflows/wf_*/
        const liveParent = join(sessionDir, SUBAGENTS_SUBDIR, WORKFLOWS_SUBDIR);
        try {
          const names = await readdir(liveParent);
          let hasLive = false;
          for (const name of names) {
            if (!name.startsWith(RUN_FILE_PREFIX) || name.endsWith(RUN_FILE_SUFFIX)) continue; // wf_<id> dir, not a file
            hasLive = true;
            liveDirs.push({
              dirPath: join(liveParent, name),
              projectHash,
              sessionUuid,
              runId: name,
            });
          }
          if (hasLive) watchDirs.add(liveParent);
        } catch {
          // no subagents/workflows dir for this session — normal
        }
      }
    }
    return { files, liveDirs, watchDirs };
  }

  private async maybeParse(file: DiscoveredRun): Promise<void> {
    let mtime: number;
    try {
      mtime = (await stat(file.filePath)).mtimeMs;
    } catch {
      return; // vanished between discover and stat
    }
    if (this.fileMtimes.get(file.filePath) === mtime) return;
    this.fileMtimes.set(file.filePath, mtime);

    const info = await this.parseFile(file);
    if (!info) return;

    const existed = this.runs.has(info.runId);
    this.runs.set(info.runId, info);
    this.runIdToPath.set(info.runId, file.filePath);
    this.emit(existed ? 'run_updated' : 'run_discovered', info);
  }

  /**
   * Re-synthesize an in-flight run from its transcript dir when its newest member
   * mtime moved (skip otherwise so we don't re-emit run_updated on idle polls).
   */
  private async maybeParseLive(live: DiscoveredLiveRun): Promise<void> {
    const info = await this.parseLiveDir(live);
    if (!info) return;
    if (this.liveDirMtimes.get(live.dirPath) === info.lastActivityAt) return;
    this.liveDirMtimes.set(live.dirPath, info.lastActivityAt);

    const existed = this.runs.has(info.runId);
    this.runs.set(info.runId, info);
    this.runIdToLiveDir.set(info.runId, live.dirPath);
    this.emit(existed ? 'run_updated' : 'run_discovered', info);
  }

  /**
   * Build a minimal ACTIVE WorkflowRunInfo from `subagents/workflows/wf_<id>/`.
   * The transcript tree carries no phases/tokens — those arrive with the
   * completion wf_*.json — so we expose: the agent slots (keyed by agentId, so the
   * card→transcript click still works), each marked done/running from journal
   * `result` lines, and lastActivityAt from the newest agent/journal mtime.
   */
  private async parseLiveDir(live: DiscoveredLiveRun): Promise<WorkflowRunInfo | null> {
    let entries: string[];
    try {
      entries = await readdir(live.dirPath);
    } catch {
      return null; // vanished between discover and read
    }

    const agentIds = new Set<string>();
    let newestMtime = 0;
    for (const name of entries) {
      if (name.startsWith(LIVE_AGENT_PREFIX)) {
        const stem = name.slice(LIVE_AGENT_PREFIX.length).replace(/\.(meta\.json|jsonl)$/, '');
        if (stem) agentIds.add(stem);
      }
      if (name === LIVE_JOURNAL_FILE || name.startsWith(LIVE_AGENT_PREFIX)) {
        try {
          const m = (await stat(join(live.dirPath, name))).mtimeMs;
          if (m > newestMtime) newestMtime = m;
        } catch {
          // entry vanished — ignore
        }
      }
    }
    if (agentIds.size === 0) return null; // nothing to show yet

    const doneIds = await this.readJournalDoneAgents(join(live.dirPath, LIVE_JOURNAL_FILE));
    const agents: WorkflowAgentInfo[] = Array.from(agentIds)
      .sort()
      .map((id, i) => ({
        index: i + 1,
        label: `agent ${i + 1}`,
        phaseIndex: 1,
        phaseTitle: '',
        model: '',
        state: doneIds.has(id) ? 'done' : 'progress',
        agentId: id,
      }));

    return {
      runId: live.runId,
      status: 'running',
      agentCount: agents.length,
      phases: [],
      agents,
      sessionUuid: live.sessionUuid,
      projectHash: live.projectHash,
      lastActivityAt: newestMtime || 0,
    };
  }

  /** Agent ids that already emitted a `result` event in the run journal. */
  private async readJournalDoneAgents(journalPath: string): Promise<Set<string>> {
    const done = new Set<string>();
    let text: string;
    try {
      text = await readFile(journalPath, 'utf-8');
    } catch {
      return done; // journal not written yet — all agents still in progress
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const ev = JSON.parse(line) as { type?: string; agentId?: string };
        if (ev && ev.type === 'result' && typeof ev.agentId === 'string') done.add(ev.agentId);
      } catch {
        // tolerate a partially-written trailing line
      }
    }
    return done;
  }

  /**
   * Parse a wf_<runId>.json into WorkflowRunInfo, STRIPPING the heavyweight
   * `script`/`scriptPath`/`result`/`logs` fields (the embedded script alone is
   * 15–660KB) so they never reach the cache, SSE, or routes.
   */
  private async parseFile(file: DiscoveredRun): Promise<WorkflowRunInfo | null> {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(await readFile(file.filePath, 'utf-8')) as Record<string, unknown>;
    } catch {
      return null; // mid-write or malformed — next mtime change re-parses
    }
    if (!raw || typeof raw !== 'object') return null;

    const progress = Array.isArray(raw.workflowProgress) ? (raw.workflowProgress as RawProgressEntry[]) : [];
    const agents: WorkflowAgentInfo[] = progress
      .filter((e) => e && e.type === 'workflow_agent')
      .map((e) => this.toAgent(e));

    const phases: WorkflowRunPhase[] = Array.isArray(raw.phases)
      ? (raw.phases as Array<Record<string, unknown>>).map((p) => ({
          title: typeof p.title === 'string' ? p.title : '',
          detail: typeof p.detail === 'string' ? p.detail : '',
        }))
      : [];

    let lastProgress = 0;
    for (const a of agents) {
      if (typeof a.lastProgressAt === 'number' && a.lastProgressAt > lastProgress) lastProgress = a.lastProgressAt;
    }
    const startTime = typeof raw.startTime === 'number' ? raw.startTime : undefined;
    const lastActivityAt = lastProgress || startTime || 0;

    return {
      runId: typeof raw.runId === 'string' ? raw.runId : file.runId,
      workflowName: typeof raw.workflowName === 'string' ? raw.workflowName : undefined,
      status: typeof raw.status === 'string' ? raw.status : undefined,
      summary: typeof raw.summary === 'string' ? raw.summary : undefined,
      agentCount: typeof raw.agentCount === 'number' ? raw.agentCount : undefined,
      totalTokens: typeof raw.totalTokens === 'number' ? raw.totalTokens : undefined,
      totalToolCalls: typeof raw.totalToolCalls === 'number' ? raw.totalToolCalls : undefined,
      durationMs: typeof raw.durationMs === 'number' ? raw.durationMs : undefined,
      startTime,
      timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : undefined,
      defaultModel: typeof raw.defaultModel === 'string' ? raw.defaultModel : undefined,
      taskId: typeof raw.taskId === 'string' ? raw.taskId : undefined,
      error: typeof raw.error === 'string' ? raw.error : undefined,
      phases,
      agents,
      sessionUuid: file.sessionUuid,
      projectHash: file.projectHash,
      lastActivityAt,
    };
  }

  private toAgent(e: RawProgressEntry): WorkflowAgentInfo {
    return {
      index: typeof e.index === 'number' ? e.index : 0,
      label: typeof e.label === 'string' ? e.label : '',
      phaseIndex: typeof e.phaseIndex === 'number' ? e.phaseIndex : 0,
      phaseTitle: typeof e.phaseTitle === 'string' ? e.phaseTitle : '',
      model: typeof e.model === 'string' ? e.model : '',
      state: typeof e.state === 'string' ? e.state : 'start',
      queuedAt: e.queuedAt,
      lastProgressAt: e.lastProgressAt,
      promptPreview: truncate(e.promptPreview, PROMPT_PREVIEW_MAX),
      agentId: e.agentId,
      startedAt: e.startedAt,
      attempt: e.attempt,
      tokens: e.tokens,
      toolCalls: e.toolCalls,
      lastToolName: e.lastToolName,
      lastToolSummary: truncate(e.lastToolSummary, RESULT_PREVIEW_MAX),
      durationMs: e.durationMs,
      resultPreview: truncate(e.resultPreview, RESULT_PREVIEW_MAX),
    };
  }

  private ensureDirWatcher(workflowsDir: string): void {
    if (this.dirWatchers.has(workflowsDir)) return;
    try {
      const watcher = chokidarWatch(workflowsDir, {
        depth: 0,
        awaitWriteFinish: { stabilityThreshold: 200 },
        ignoreInitial: true,
        persistent: false,
      });
      const handler = () => this.poll();
      watcher.on('add', handler);
      watcher.on('change', handler);
      watcher.on('unlink', handler);
      // subagents/workflows/ children are wf_<id>/ DIRS — catch their add/remove too.
      watcher.on('addDir', handler);
      watcher.on('unlinkDir', handler);
      watcher.on('error', () => {
        // chokidar surfaced an error for this dir — drop the watcher; poll still covers it.
        this.removeDirWatcher(workflowsDir);
      });
      this.dirWatchers.set(workflowsDir, watcher);
    } catch {
      // Watch setup failed — periodic poll still discovers changes.
    }
  }

  private removeDirWatcher(workflowsDir: string): void {
    const watcher = this.dirWatchers.get(workflowsDir);
    if (watcher) {
      watcher.close().catch(() => {});
      this.dirWatchers.delete(workflowsDir);
    }
  }
}

/** Process-wide singleton (mirrors subagentWatcher / imageWatcher). */
export const workflowRunWatcher = new WorkflowRunWatcher();
