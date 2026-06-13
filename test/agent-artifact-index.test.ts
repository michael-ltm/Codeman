/**
 * Tests for AgentArtifactIndex — the subagent → produced-files join.
 *
 * Driven through a bare EventEmitter standing in for `subagentWatcher`, so no real
 * transcript files, tmux, or server are involved.
 */
import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeEach } from 'vitest';
import { AgentArtifactIndex, type AgentArtifact } from '../src/agent-artifact-index.js';
import { MAX_ARTIFACTS_PER_AGENT } from '../src/config/map-limits.js';

/** Build a `subagent:tool_call` payload like the watcher emits. */
function toolCall(over: {
  agentId?: string;
  sessionId?: string;
  tool: string;
  input: Record<string, unknown>;
  timestamp?: string;
}) {
  return {
    agentId: over.agentId ?? 'agent-1',
    sessionId: over.sessionId ?? 'sess-1',
    timestamp: over.timestamp ?? '2026-06-13T05:44:00.000Z',
    tool: over.tool,
    input: over.input,
    toolUseId: 'toolu_x',
    fullInput: over.input,
  };
}

describe('AgentArtifactIndex', () => {
  let index: AgentArtifactIndex;
  let source: EventEmitter;

  beforeEach(() => {
    source = new EventEmitter();
    index = new AgentArtifactIndex();
    index.start(source);
  });

  function emitCall(over: Parameters<typeof toolCall>[0]) {
    source.emit('subagent:tool_call', toolCall(over));
  }

  it('records a Write as an artifact and classifies HTML', () => {
    const added: AgentArtifact[] = [];
    index.on('artifact:added', (a) => added.push(a));

    emitCall({
      tool: 'Write',
      input: { file_path: '/home/arkon/proj/mockups/01-aurora.html', content: '<!doctype html>' },
    });

    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      agentId: 'agent-1',
      sessionId: 'sess-1',
      path: '/home/arkon/proj/mockups/01-aurora.html',
      filename: '01-aurora.html',
      ext: '.html',
      kind: 'html',
      source: 'write',
      writeCount: 1,
    });
    expect(index.getArtifactsForAgent('agent-1')).toHaveLength(1);
  });

  it('dedupes repeated writes/edits of the same path and counts them', () => {
    const updated: AgentArtifact[] = [];
    index.on('artifact:updated', (a) => updated.push(a));

    emitCall({ tool: 'Write', input: { file_path: '/p/a.html', content: '1' }, timestamp: '2026-06-13T05:00:00.000Z' });
    emitCall({
      tool: 'Edit',
      input: { file_path: '/p/a.html', old_string: '1', new_string: '2' },
      timestamp: '2026-06-13T05:01:00.000Z',
    });
    emitCall({ tool: 'Edit', input: { file_path: '/p/a.html' }, timestamp: '2026-06-13T05:02:00.000Z' });

    const arts = index.getArtifactsForAgent('agent-1');
    expect(arts).toHaveLength(1);
    expect(arts[0].writeCount).toBe(3);
    expect(arts[0].source).toBe('write'); // first attribution wins
    expect(arts[0].lastWriteAt).toBe(Date.parse('2026-06-13T05:02:00.000Z'));
    expect(arts[0].firstSeenAt).toBe(Date.parse('2026-06-13T05:00:00.000Z'));
    expect(updated).toHaveLength(2);
  });

  it('normalizes ../. in absolute paths so they dedupe', () => {
    emitCall({ tool: 'Write', input: { file_path: '/p/sub/../a.html', content: '' } });
    emitCall({ tool: 'Write', input: { file_path: '/p/a.html', content: '' } });
    expect(index.getArtifactsForAgent('agent-1')).toHaveLength(1);
    expect(index.getArtifactsForAgent('agent-1')[0].path).toBe('/p/a.html');
  });

  it('ignores non-file tools and writes missing a path', () => {
    emitCall({ tool: 'Read', input: { file_path: '/p/a.html' } });
    emitCall({ tool: 'Bash', input: { command: 'node capture.mjs' } });
    emitCall({ tool: 'Write', input: { content: 'no path' } });
    expect(index.count()).toBe(0);
  });

  it('handles NotebookEdit via notebook_path with notebook source', () => {
    emitCall({ tool: 'NotebookEdit', input: { notebook_path: '/p/analysis.ipynb', new_source: 'x' } });
    const arts = index.getArtifactsForAgent('agent-1');
    expect(arts).toHaveLength(1);
    expect(arts[0].source).toBe('notebook');
    expect(arts[0].kind).toBe('other'); // .ipynb not in the render map
  });

  it.each([
    ['/p/x.png', 'image'],
    ['/p/x.PNG', 'image'],
    ['/p/x.svg', 'image'],
    ['/p/x.pdf', 'pdf'],
    ['/p/x.docx', 'document'],
    ['/p/x.pptx', 'document'],
    ['/p/x.md', 'markdown'],
    ['/p/x.txt', 'text'],
    ['/p/x.css', 'code'],
    ['/p/x.ts', 'code'],
    ['/p/x.bin', 'other'],
    ['/p/Makefile', 'other'],
  ])('classifies %s as %s', (file, kind) => {
    emitCall({ tool: 'Write', input: { file_path: file, content: '' } });
    expect(index.getAllArtifacts()[0].kind).toBe(kind);
  });

  it('groups artifacts by agent and by session', () => {
    emitCall({ agentId: 'a1', sessionId: 's1', tool: 'Write', input: { file_path: '/p/1.html', content: '' } });
    emitCall({ agentId: 'a2', sessionId: 's1', tool: 'Write', input: { file_path: '/p/2.html', content: '' } });
    emitCall({ agentId: 'a3', sessionId: 's2', tool: 'Write', input: { file_path: '/p/3.html', content: '' } });

    expect(index.getArtifactsForAgent('a1')).toHaveLength(1);
    expect(
      index
        .getArtifactsForSession('s1')
        .map((a) => a.agentId)
        .sort()
    ).toEqual(['a1', 'a2']);
    expect(index.getArtifactsForSession('s2')).toHaveLength(1);
    expect(index.count()).toBe(3);
  });

  it('sorts results most-recently-written first', () => {
    emitCall({
      tool: 'Write',
      input: { file_path: '/p/old.html', content: '' },
      timestamp: '2026-06-13T01:00:00.000Z',
    });
    emitCall({
      tool: 'Write',
      input: { file_path: '/p/new.html', content: '' },
      timestamp: '2026-06-13T09:00:00.000Z',
    });
    expect(index.getArtifactsForAgent('agent-1').map((a) => a.filename)).toEqual(['new.html', 'old.html']);
  });

  it('records external artifacts (image-watcher correlation hook)', () => {
    index.recordExternalArtifact(
      'agent-1',
      'sess-1',
      '/p/shots/01-desktop.png',
      Date.parse('2026-06-13T05:45:00.000Z')
    );
    const arts = index.getArtifactsForAgent('agent-1');
    expect(arts).toHaveLength(1);
    expect(arts[0]).toMatchObject({ source: 'external', kind: 'image', filename: '01-desktop.png' });
  });

  it('bounds artifacts per agent with FIFO eviction', () => {
    for (let i = 0; i < MAX_ARTIFACTS_PER_AGENT + 5; i++) {
      emitCall({ tool: 'Write', input: { file_path: `/p/f${i}.html`, content: '' } });
    }
    expect(index.getArtifactsForAgent('agent-1')).toHaveLength(MAX_ARTIFACTS_PER_AGENT);
    // Oldest (f0..f4) evicted; newest retained.
    expect(index.getArtifact('agent-1', '/p/f0.html')).toBeUndefined();
    expect(index.getArtifact('agent-1', `/p/f${MAX_ARTIFACTS_PER_AGENT + 4}.html`)).toBeDefined();
  });

  it('stop() detaches from the source; clear() drops artifacts', () => {
    emitCall({ tool: 'Write', input: { file_path: '/p/a.html', content: '' } });
    index.stop();
    emitCall({ tool: 'Write', input: { file_path: '/p/b.html', content: '' } });
    expect(index.count()).toBe(1); // second call ignored after stop

    index.clear();
    expect(index.count()).toBe(0);
  });

  it('start() is idempotent — no double counting on repeat start with same source', () => {
    index.start(source);
    index.start(source);
    const added: AgentArtifact[] = [];
    index.on('artifact:added', (a) => added.push(a));
    emitCall({ tool: 'Write', input: { file_path: '/p/a.html', content: '' } });
    expect(added).toHaveLength(1);
  });

  it('clearAgent() drops only the named agent', () => {
    emitCall({ agentId: 'a1', tool: 'Write', input: { file_path: '/p/1.html', content: '' } });
    emitCall({ agentId: 'a2', tool: 'Write', input: { file_path: '/p/2.html', content: '' } });
    index.clearAgent('a1');
    expect(index.getArtifactsForAgent('a1')).toHaveLength(0);
    expect(index.getArtifactsForAgent('a2')).toHaveLength(1);
  });
});
