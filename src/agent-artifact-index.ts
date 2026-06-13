/**
 * @fileoverview Agent Artifact Index — joins each subagent to the files it produced.
 *
 * The load-bearing piece behind the Agent Gallery view. It answers "which files did
 * this subagent write?" by subscribing to {@link subagentWatcher} events rather than
 * re-reading transcripts: every `subagent:tool_call` for a file-producing tool
 * (Write/Edit/MultiEdit/NotebookEdit) carries the agent id, session id, and the full
 * tool input — including `file_path` — so the join is exact and free of duplicate I/O.
 *
 * What it stores is METADATA ONLY (paths, kinds, write counts). It never reads or
 * serves file contents — guard enforcement (realpath, sensitive-path, attachment-guard,
 * extension allowlist) lives in the serving layer that turns these paths into
 * attachment/artifact ids. Treat the recorded path as untrusted: it originates from a
 * subagent transcript and must pass the guard chain before anything reads it.
 *
 * Key exports:
 * - `AgentArtifactIndex` class — EventEmitter; `start(source?)` / `stop()` lifecycle
 * - `agentArtifactIndex` — pre-instantiated singleton
 * - `AgentArtifact`, `ArtifactKind`, `ArtifactSource`, `AgentArtifactIndexEvents` — types
 *
 * Extension point: `recordExternalArtifact()` lets a later image-watcher correlation
 * attribute Bash-written screenshots (which never appear as a Write tool_use) to the
 * agent that was active when the file landed. The transcript join below stands alone.
 *
 * @emits artifact:added (new path for an agent), artifact:updated (re-write of a known
 *   path), artifact:error
 * @dependencies subagent-watcher (event source), config/map-limits (bounds)
 * @consumedby web/server (SSE broadcast as `agent:artifact`), gallery route
 * @module agent-artifact-index
 */

import { EventEmitter } from 'node:events';
import { basename, extname, isAbsolute, resolve } from 'node:path';
import { MAX_ARTIFACTS_PER_AGENT, MAX_TRACKED_AGENTS } from './config/map-limits.js';
import { subagentWatcher, type SubagentToolCall } from './subagent-watcher.js';

// ========== Types ==========

export type ArtifactKind = 'html' | 'image' | 'pdf' | 'document' | 'markdown' | 'text' | 'code' | 'other';

/** How the artifact was attributed to its agent. */
export type ArtifactSource = 'write' | 'edit' | 'notebook' | 'external';

export interface AgentArtifact {
  agentId: string;
  sessionId: string;
  /** Absolute path, normalized (`resolve`d) when absolute; left raw otherwise. */
  path: string;
  /** `basename(path)`. */
  filename: string;
  /** Lowercased extension including the dot (e.g. `.html`); `''` when none. */
  ext: string;
  /** Render hint derived from {@link ext}. Drives the gallery's preview mode. */
  kind: ArtifactKind;
  source: ArtifactSource;
  /** Epoch ms when this path was first attributed to the agent. */
  firstSeenAt: number;
  /** Epoch ms of the most recent write/edit of this path. */
  lastWriteAt: number;
  /** Number of write/edit calls observed against this path. */
  writeCount: number;
}

/** Typed event map (Node 22 typed EventEmitter, matching {@link BashToolParser}). */
export interface AgentArtifactIndexEvents {
  'artifact:added': [AgentArtifact];
  'artifact:updated': [AgentArtifact];
  'artifact:error': [Error];
}

/** Minimal structural type for the event source, for testability without the real watcher. */
type ToolCallEmitter = Pick<EventEmitter, 'on' | 'off'>;

// ========== Constants ==========

/** Tools whose successful call means the agent produced/changed a file. */
const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const KIND_BY_EXT: Readonly<Record<string, ArtifactKind>> = {
  '.html': 'html',
  '.htm': 'html',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.avif': 'image',
  '.svg': 'image',
  '.pdf': 'pdf',
  '.docx': 'document',
  '.pptx': 'document',
  '.xlsx': 'document',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.txt': 'text',
  '.log': 'text',
  '.csv': 'text',
  '.js': 'code',
  '.mjs': 'code',
  '.cjs': 'code',
  '.ts': 'code',
  '.tsx': 'code',
  '.jsx': 'code',
  '.css': 'code',
  '.json': 'code',
  '.py': 'code',
  '.sh': 'code',
  '.yml': 'code',
  '.yaml': 'code',
};

// ========== Helpers ==========

function classifyKind(ext: string): ArtifactKind {
  return KIND_BY_EXT[ext] ?? 'other';
}

function sourceForTool(tool: string): ArtifactSource {
  if (tool === 'Write') return 'write';
  if (tool === 'NotebookEdit') return 'notebook';
  return 'edit'; // Edit, MultiEdit
}

/**
 * Resolve `..`/`.` for absolute paths so repeat writes dedupe to one artifact.
 * Relative paths are left raw: `resolve()` would anchor them to the SERVER cwd, not the
 * agent's, producing a wrong absolute path. Write requires absolute paths, so this is rare.
 */
function normalizePath(p: string): string {
  return isAbsolute(p) ? resolve(p) : p;
}

/** ISO transcript timestamp → epoch ms, falling back to now. */
function timestampToMs(ts: string | undefined): number {
  if (ts) {
    const n = Date.parse(ts);
    if (!Number.isNaN(n)) return n;
  }
  return Date.now();
}

/** Extract the target path from a file-tool's input (Write/Edit use `file_path`, NotebookEdit `notebook_path`). */
function extractFilePath(input: Record<string, unknown> | undefined): string | undefined {
  const candidate = input?.file_path ?? input?.notebook_path;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

// ========== AgentArtifactIndex ==========

export class AgentArtifactIndex extends EventEmitter<AgentArtifactIndexEvents> {
  /** agentId → (normalized path → artifact). Outer map is insertion-ordered for FIFO eviction. */
  private readonly byAgent = new Map<string, Map<string, AgentArtifact>>();

  private source: ToolCallEmitter | null = null;
  private readonly onToolCall = (call: SubagentToolCall): void => {
    try {
      if (!FILE_WRITE_TOOLS.has(call.tool)) return;
      const rawPath = extractFilePath(call.fullInput);
      if (!rawPath) return;
      this.record(call.agentId, call.sessionId, rawPath, sourceForTool(call.tool), timestampToMs(call.timestamp));
    } catch (err) {
      this.emit('artifact:error', err instanceof Error ? err : new Error(String(err)));
    }
  };

  /**
   * Begin attributing artifacts. Idempotent. Defaults to the real {@link subagentWatcher};
   * tests pass a bare EventEmitter and drive `subagent:tool_call` directly.
   */
  start(source: ToolCallEmitter = subagentWatcher): void {
    if (this.source) {
      if (this.source === source) return;
      this.stop();
    }
    this.source = source;
    source.on('subagent:tool_call', this.onToolCall as (...args: unknown[]) => void);
  }

  /** Detach from the event source. Retains recorded artifacts (use {@link clear} to drop them). */
  stop(): void {
    if (this.source) {
      this.source.off('subagent:tool_call', this.onToolCall as (...args: unknown[]) => void);
      this.source = null;
    }
  }

  /**
   * Attribute a file discovered outside the transcript — e.g. a screenshot written by a
   * Bash `capture.mjs`, correlated by the image-watcher to the agent active when it landed.
   * Marked `source: 'external'`. (Wired for a follow-up; not yet called by the image-watcher.)
   */
  recordExternalArtifact(agentId: string, sessionId: string, absPath: string, atMs: number = Date.now()): void {
    if (typeof absPath !== 'string' || absPath.length === 0) return;
    this.record(agentId, sessionId, absPath, 'external', atMs);
  }

  private record(agentId: string, sessionId: string, rawPath: string, source: ArtifactSource, atMs: number): void {
    const path = normalizePath(rawPath);

    let bucket = this.byAgent.get(agentId);
    if (!bucket) {
      // Bound the number of tracked agents (FIFO eviction of the oldest agent).
      if (this.byAgent.size >= MAX_TRACKED_AGENTS) {
        const oldest = this.byAgent.keys().next().value;
        if (oldest !== undefined) this.byAgent.delete(oldest);
      }
      bucket = new Map();
      this.byAgent.set(agentId, bucket);
    }

    const existing = bucket.get(path);
    if (existing) {
      existing.lastWriteAt = Math.max(existing.lastWriteAt, atMs);
      existing.firstSeenAt = Math.min(existing.firstSeenAt, atMs);
      existing.writeCount += 1;
      existing.sessionId = sessionId; // tolerate late/corrected session attribution
      this.emit('artifact:updated', existing);
      return;
    }

    // Bound artifacts per agent (FIFO eviction of the oldest path for this agent).
    if (bucket.size >= MAX_ARTIFACTS_PER_AGENT) {
      const oldest = bucket.keys().next().value;
      if (oldest !== undefined) bucket.delete(oldest);
    }

    const ext = extname(path).toLowerCase();
    const artifact: AgentArtifact = {
      agentId,
      sessionId,
      path,
      filename: basename(path),
      ext,
      kind: classifyKind(ext),
      source,
      firstSeenAt: atMs,
      lastWriteAt: atMs,
      writeCount: 1,
    };
    bucket.set(path, artifact);
    this.emit('artifact:added', artifact);
  }

  /** Artifacts written by one agent, most-recently-written first. */
  getArtifactsForAgent(agentId: string): AgentArtifact[] {
    const bucket = this.byAgent.get(agentId);
    if (!bucket) return [];
    return [...bucket.values()].sort((a, b) => b.lastWriteAt - a.lastWriteAt);
  }

  /** Artifacts across every agent in a Codeman session, most-recently-written first. */
  getArtifactsForSession(sessionId: string): AgentArtifact[] {
    const out: AgentArtifact[] = [];
    for (const bucket of this.byAgent.values()) {
      for (const artifact of bucket.values()) {
        if (artifact.sessionId === sessionId) out.push(artifact);
      }
    }
    return out.sort((a, b) => b.lastWriteAt - a.lastWriteAt);
  }

  /** Every tracked artifact, most-recently-written first. */
  getAllArtifacts(): AgentArtifact[] {
    const out: AgentArtifact[] = [];
    for (const bucket of this.byAgent.values()) out.push(...bucket.values());
    return out.sort((a, b) => b.lastWriteAt - a.lastWriteAt);
  }

  getArtifact(agentId: string, path: string): AgentArtifact | undefined {
    return this.byAgent.get(agentId)?.get(normalizePath(path));
  }

  /** Total number of tracked artifacts across all agents. */
  count(): number {
    let n = 0;
    for (const bucket of this.byAgent.values()) n += bucket.size;
    return n;
  }

  /** Drop all artifacts for one agent (e.g. when its subagent window is dismissed). */
  clearAgent(agentId: string): void {
    this.byAgent.delete(agentId);
  }

  /** Drop everything. */
  clear(): void {
    this.byAgent.clear();
  }
}

/** Pre-instantiated singleton, mirroring `subagentWatcher`. Call `.start()` to attach. */
export const agentArtifactIndex = new AgentArtifactIndex();
