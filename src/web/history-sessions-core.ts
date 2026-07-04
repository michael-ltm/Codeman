/**
 * @fileoverview History-session listing core — the reusable logic behind
 * `GET /api/history/sessions` (session-routes.ts), extracted (Task 6 refactor
 * pattern: handler = parse → core → serialize) so the fleet can reuse the exact
 * same listing for its cross-device "Resume Conversation" candidates
 * (LocalSessionOps.listResumeCandidates → local-session-ops.ts).
 *
 * It scans `~/.claude/projects/<projectKey>/*.jsonl` transcripts, decoding each
 * project key back to a filesystem path and sniffing the first real user prompt
 * out of the transcript head/tail. Two modes:
 * - global overview (no projectKey): scan every project, return the 50 most
 *   recently-modified sessions.
 * - drill-down (projectKey given): scan only that project with offset/limit
 *   pagination, returning `{ sessions, total }`.
 *
 * Everything here is pure filesystem read logic with no Fastify/route
 * dependencies, so it is unit-testable and callable from the fleet layer.
 *
 * Key exports:
 * - HistorySession — one listed transcript
 * - listHistorySessions — the core listing function (both modes)
 */

import fs from 'node:fs/promises';
import { join } from 'node:path';

/** One resumable past conversation, as surfaced by the history listing. */
export interface HistorySession {
  sessionId: string;
  workingDir: string;
  projectKey: string;
  sizeBytes: number;
  lastModified: string;
  firstPrompt?: string;
}

/** Options for {@link listHistorySessions}. */
export interface ListHistorySessionsOptions {
  /** Home directory whose `.claude/projects` tree is scanned. Default `$HOME` (else `/tmp`). */
  homeDir?: string;
  /** Single-project drill-down: scan only this project key, with offset/limit paging. */
  projectKey?: string;
  /** Drill-down page offset (clamped ≥0, default 0). Ignored in overview mode. */
  offset?: number;
  /** Drill-down page size (clamped 1..100, default 20). Ignored in overview mode. */
  limit?: number;
}

/** Result of {@link listHistorySessions}; `total` is present only in drill-down mode. */
export interface ListHistorySessionsResult {
  sessions: HistorySession[];
  total?: number;
}

/** Max sessions returned by the global overview (no projectKey). */
const OVERVIEW_LIMIT = 50;

/**
 * List resumable Claude conversations from `~/.claude/projects`.
 *
 * With a `projectKey`, scans only that project with offset/limit paging and
 * returns `{ sessions, total }`. Without one, scans every project and returns
 * the 50 most-recently-modified as `{ sessions }`. An invalid `projectKey`
 * (fails the `[A-Za-z0-9_-]+` allowlist, i.e. path-traversal attempt) yields
 * `{ sessions: [], total: 0 }`.
 */
export async function listHistorySessions(opts: ListHistorySessionsOptions = {}): Promise<ListHistorySessionsResult> {
  const projectsDir = join(opts.homeDir || process.env.HOME || '/tmp', '.claude', 'projects');
  const headBuf = Buffer.alloc(16384);

  // Single-folder drill-down: scan only that directory, bypass the overview cap,
  // and honor offset/limit pagination.
  if (opts.projectKey) {
    if (!/^[A-Za-z0-9_-]+$/.test(opts.projectKey)) {
      return { sessions: [], total: 0 };
    }
    const offset = Math.max(0, Number.isFinite(opts.offset) ? Math.floor(opts.offset as number) : 0);
    const limit = Math.min(100, Math.max(1, Number.isFinite(opts.limit) ? Math.floor(opts.limit as number) : 20));
    const projPath = join(projectsDir, opts.projectKey);
    const all = await scanProjectDir(projPath, opts.projectKey, headBuf);
    all.sort(byLastModifiedDesc);
    return { sessions: all.slice(offset, offset + limit), total: all.length };
  }

  // Global overview: scan all projects, return up to 50 most-recent sessions.
  const results: HistorySession[] = [];
  try {
    const projectDirs = await fs.readdir(projectsDir);
    for (const projDir of projectDirs) {
      const projPath = join(projectsDir, projDir);
      const list = await scanProjectDir(projPath, projDir, headBuf);
      results.push(...list);
    }
  } catch {
    // Projects dir may not exist.
  }

  results.sort(byLastModifiedDesc);
  return { sessions: results.slice(0, OVERVIEW_LIMIT) };
}

function byLastModifiedDesc(a: HistorySession, b: HistorySession): number {
  return new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime();
}

/**
 * Scan a single project directory and return all valid history sessions in it.
 * Reused by both the global overview and the single-folder drill-down.
 */
async function scanProjectDir(projPath: string, projDir: string, headBuf: Buffer): Promise<HistorySession[]> {
  const out: HistorySession[] = [];
  const stat = await fs.stat(projPath).catch(() => null);
  if (!stat?.isDirectory()) return out;

  const workingDir = await decodeProjectKey(projDir);
  const entries = await fs.readdir(projPath).catch(() => [] as string[]);

  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;
    const sessionId = entry.replace('.jsonl', '');
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(sessionId)) continue;

    const filePath = join(projPath, entry);
    const fileStat = await fs.stat(filePath).catch(() => null);
    if (!fileStat) continue;
    if (fileStat.size < 4000) continue;

    let firstPrompt: string | undefined;
    const head = await readFileHead(filePath, headBuf);
    const hasConversation = (text: string) =>
      text.includes('"type":"user"') || text.includes('"type":"assistant"') || text.includes('"type":"summary"');

    let foundContent = head ? hasConversation(head) : false;
    let tail: string | null = null;
    if (!foundContent && fileStat.size > 16384) {
      const tailBuf = Buffer.alloc(32768);
      tail = await readFileTail(filePath, tailBuf, fileStat.size);
      if (tail) foundContent = hasConversation(tail);
    }
    if (!foundContent) continue;

    if (head) firstPrompt = extractFirstUserPrompt(head);
    if (!firstPrompt && fileStat.size > 65536) {
      if (!tail) {
        const tailBuf = Buffer.alloc(32768);
        tail = await readFileTail(filePath, tailBuf, fileStat.size);
      }
      if (tail) firstPrompt = extractFirstUserPrompt(tail);
    }

    out.push({
      sessionId,
      workingDir,
      projectKey: projDir,
      sizeBytes: fileStat.size,
      lastModified: fileStat.mtime.toISOString(),
      firstPrompt,
    });
  }
  return out;
}

const MAX_PROMPT_LEN = 120;

function promptTextFromContent(content: unknown): string | undefined {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const textBlock = content.find((b): b is { type: string; text?: string } => {
    return typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text';
  });
  return typeof textBlock?.text === 'string' ? textBlock.text : undefined;
}

function sanitizeUserPromptText(text: string): string | undefined {
  text = text
    // Drop Claude-injected XML blocks before removing any remaining XML-like tags.
    .replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi, ' ')
    .replace(/<command-message\b[^>]*>[\s\S]*?<\/command-message>/gi, ' ')
    .replace(/<local-command-(?:stdout|stderr)\b[^>]*>[\s\S]*?<\/local-command-(?:stdout|stderr)>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(new RegExp(String.raw`\x1b\[[0-9;]*[a-zA-Z]`, 'g'), '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!text) return undefined;
  // Skip system-injected messages, slash command artifacts, and expanded skill prompts
  if (
    /^(Caveat:|init\b|clear\b|resume\b|\/[a-z][\w-]*\b|You are a |\[Request |Set model to )/i.test(text) ||
    /^(Please )?(analyze|review) this codebase/i.test(text) ||
    /^(Read|Implement the following) .+, then (search|list|check) /i.test(text) ||
    /^\d+ vulnerabilit/i.test(text) ||
    /\btoolu_/.test(text) ||
    /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+/.test(text) ||
    /\b(sk-ant-|ANTHROPIC_API_KEY|API_KEY=|SECRET|TOKEN=)/i.test(text) ||
    text.length < 8
  )
    return undefined;
  return text.length > MAX_PROMPT_LEN ? text.slice(0, MAX_PROMPT_LEN) + '…' : text;
}

/** Extract the text of one user message entry from a parsed transcript/live stream object. */
export function extractUserPromptFromEntry(entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const typed = entry as { type?: unknown; message?: { content?: unknown } };
  if (typed.type !== 'user' || typeof typed.message !== 'object' || typed.message === null) return undefined;
  const text = promptTextFromContent(typed.message.content);
  return text ? sanitizeUserPromptText(text) : undefined;
}

/** Extract the text of the first user message from a JSONL transcript head. */
export function extractFirstUserPrompt(head: string): string | undefined {
  // Iterate lines without allocating a full split array
  let start = 0;
  while (start < head.length) {
    const end = head.indexOf('\n', start);
    const line = end === -1 ? head.slice(start) : head.slice(start, end);
    start = end === -1 ? head.length : end + 1;
    if (!line.includes('"type":"user"')) continue;
    try {
      const entry = JSON.parse(line);
      const prompt = extractUserPromptFromEntry(entry);
      if (prompt) return prompt;
    } catch {
      // Malformed line — skip
    }
  }
  return undefined;
}

/**
 * Decode a Claude project key (e.g. "-Users-teigen-Documents-Workspace-AI-project-Mirror")
 * back to a filesystem path ("/Users/teigen/Documents/Workspace/AI_project/Mirror").
 *
 * Claude CLI encodes both '/' and '_' as '-', so each '-' in the key could be
 * any of: '/' (path separator), '_' (underscore), or '-' (literal dash).
 *
 * Strategy: recursive backtracking with longest-match-first preference.
 * At each segment boundary, try joining as many segments as possible (with '_'
 * or '-') into a single existing directory name. If a shorter match leads to a
 * dead end, backtrack and try the next-shorter candidate.
 *
 * Why backtracking: when both `diary/` and `diary-app/` exist as siblings, the
 * naive shortest-match would pick `diary` and then fail to find `app` inside,
 * leaving the rest of the key unresolved. Longest-first picks `diary-app`.
 */
export async function decodeProjectKey(projKey: string): Promise<string> {
  const encoded = projKey.startsWith('-') ? projKey.slice(1) : projKey;
  const segments = encoded.split('-');

  const isDirCache = new Map<string, boolean>();
  const isDir = async (p: string): Promise<boolean> => {
    const cached = isDirCache.get(p);
    if (cached !== undefined) return cached;
    const result = await fs
      .stat(p)
      .then((s) => s.isDirectory())
      .catch(() => false);
    isDirCache.set(p, result);
    return result;
  };

  // Recursive backtracking: returns the deepest valid path that consumes all
  // segments. Tries the longest segment-join first at each step so that
  // dash-containing directory names win over shorter same-prefix siblings.
  async function tryDecode(idx: number, current: string): Promise<string | null> {
    if (idx >= segments.length) return current;
    const maxLook = Math.min(idx + 4, segments.length);
    // Longest first: end = maxLook-1 down to idx
    for (let end = maxLook - 1; end >= idx; end--) {
      const candidates: string[] = [];
      if (end === idx) {
        candidates.push(segments[idx]);
      } else {
        candidates.push(segments.slice(idx, end + 1).join('-'));
        candidates.push(segments.slice(idx, end + 1).join('_'));
      }
      for (const child of candidates) {
        const candidate = current + '/' + child;
        if (await isDir(candidate)) {
          const result = await tryDecode(end + 1, candidate);
          if (result) return result;
        }
      }
    }
    return null;
  }

  const decoded = await tryDecode(0, '');
  if (decoded) return decoded;

  // Fallback: greedy shortest-match (original behavior) — best effort when
  // no fully-valid path exists (e.g. directory was deleted after the
  // conversation was recorded).
  let current = '';
  let i = 0;
  while (i < segments.length) {
    let matched = false;
    const maxLook = Math.min(i + 4, segments.length);
    for (let end = i; end < maxLook; end++) {
      const candidates: string[] = [];
      if (end === i) {
        candidates.push(segments[i]);
      } else {
        candidates.push(segments.slice(i, end + 1).join('_'));
        candidates.push(segments.slice(i, end + 1).join('-'));
      }
      for (const child of candidates) {
        const candidate = current + '/' + child;
        if (await isDir(candidate)) {
          current = candidate;
          i = end + 1;
          matched = true;
          break;
        }
      }
      if (matched) break;
    }
    if (!matched) {
      current = current + '/' + segments[i];
      i++;
    }
  }
  const finalExists = await fs
    .access(current)
    .then(() => true)
    .catch(() => false);
  return finalExists ? current : process.env.HOME || '/tmp';
}

/** Read the first `buf.length` bytes of a file for content sniffing. */
async function readFileHead(path: string, buf: Buffer): Promise<string | null> {
  try {
    const fd = await fs.open(path, 'r');
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    await fd.close();
    return buf.toString('utf8', 0, bytesRead);
  } catch {
    return null;
  }
}

/** Read the last `buf.length` bytes of a file (for tail-scanning user prompts). */
async function readFileTail(path: string, buf: Buffer, fileSize: number): Promise<string | null> {
  try {
    const fd = await fs.open(path, 'r');
    const offset = Math.max(0, fileSize - buf.length);
    const { bytesRead } = await fd.read(buf, 0, buf.length, offset);
    await fd.close();
    const text = buf.toString('utf8', 0, bytesRead);
    // Skip first partial line when we didn't read from the start
    if (offset > 0) {
      const nl = text.indexOf('\n');
      return nl >= 0 ? text.slice(nl + 1) : null;
    }
    return text;
  } catch {
    return null;
  }
}
