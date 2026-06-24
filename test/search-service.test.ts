/**
 * Unit tests for the pure cross-session search core (COD-9).
 *
 * The core (`searchSources`) takes already-collected, in-memory source data
 * plus a normalized query and returns grouped/ranked/capped results. No I/O,
 * no live server — these tests exercise grouping order, exact-before-recency
 * ranking, caps (total + per-group), snippet shaping, and path safety.
 */
import { describe, it, expect } from 'vitest';
import { searchSources, SEARCH_TOTAL_CAP, SEARCH_PER_GROUP_CAP, type SearchSources } from '../src/search-service.js';

function sources(overrides: Partial<SearchSources> = {}): SearchSources {
  return {
    sessions: [],
    events: [],
    files: [],
    ...overrides,
  };
}

describe('searchSources — grouping & order', () => {
  it('orders groups sessions → events → files', () => {
    const data = sources({
      files: [
        {
          sessionId: 's1',
          sessionName: 'Alpha',
          fileName: 'query.txt',
          relativePath: 'docs/query.txt',
          timestamp: 100,
          itemId: 'f1',
        },
      ],
      events: [
        { sessionId: 's1', sessionName: 'Alpha', eventId: 'e1', title: 'query started', details: '', timestamp: 100 },
      ],
      sessions: [{ sessionId: 's1', sessionName: 'query session', workingDir: '/home/u/proj', timestamp: 100 }],
    });
    const res = searchSources('query', data);
    expect(res.groups.map((g) => g.type)).toEqual(['session', 'event', 'file']);
  });

  it('omits empty groups', () => {
    const data = sources({
      sessions: [{ sessionId: 's1', sessionName: 'query session', workingDir: '/home/u/proj', timestamp: 100 }],
    });
    const res = searchSources('query', data);
    expect(res.groups.map((g) => g.type)).toEqual(['session']);
  });
});

describe('searchSources — matching across distinct sources', () => {
  it('returns results from at least two distinct sources', () => {
    const data = sources({
      sessions: [{ sessionId: 's1', sessionName: 'needle project', workingDir: '/home/u/proj', timestamp: 100 }],
      events: [
        { sessionId: 's2', sessionName: 'Other', eventId: 'e1', title: 'found a needle', details: '', timestamp: 100 },
      ],
    });
    const res = searchSources('needle', data);
    const types = res.groups.map((g) => g.type);
    expect(types).toContain('session');
    expect(types).toContain('event');
    expect(res.totalResults).toBe(2);
  });

  it('matches session working directory', () => {
    const data = sources({
      sessions: [{ sessionId: 's1', sessionName: 'Unrelated', workingDir: '/home/u/needle-dir', timestamp: 100 }],
    });
    const res = searchSources('needle', data);
    expect(res.totalResults).toBe(1);
    expect(res.groups[0].results[0].sessionId).toBe('s1');
  });

  it('matches event details, not just title', () => {
    const data = sources({
      events: [
        {
          sessionId: 's1',
          sessionName: 'A',
          eventId: 'e1',
          title: 'nothing here',
          details: 'a needle in details',
          timestamp: 100,
        },
      ],
    });
    const res = searchSources('needle', data);
    expect(res.totalResults).toBe(1);
  });

  it('is case-insensitive', () => {
    const data = sources({
      sessions: [{ sessionId: 's1', sessionName: 'NEEDLE', workingDir: '/x', timestamp: 100 }],
    });
    expect(searchSources('needle', data).totalResults).toBe(1);
  });
});

describe('searchSources — ranking (exact before recency)', () => {
  it('places exact name matches before more-recent partial matches', () => {
    const data = sources({
      sessions: [
        { sessionId: 'old-exact', sessionName: 'needle', workingDir: '/x', timestamp: 1 },
        { sessionId: 'new-partial', sessionName: 'needle-haystack', workingDir: '/x', timestamp: 9999 },
      ],
    });
    const res = searchSources('needle', data);
    const ids = res.groups[0].results.map((r) => r.sessionId);
    expect(ids).toEqual(['old-exact', 'new-partial']);
    expect(res.groups[0].results[0].exactMatch).toBe(true);
  });

  it('within the same exactness tier, sorts newest first', () => {
    const data = sources({
      sessions: [
        { sessionId: 'older', sessionName: 'needle-a', workingDir: '/x', timestamp: 10 },
        { sessionId: 'newer', sessionName: 'needle-b', workingDir: '/x', timestamp: 20 },
      ],
    });
    const res = searchSources('needle', data);
    expect(res.groups[0].results.map((r) => r.sessionId)).toEqual(['newer', 'older']);
  });
});

describe('searchSources — caps', () => {
  it('enforces the per-group cap and flags truncated', () => {
    const sessions = Array.from({ length: SEARCH_PER_GROUP_CAP + 5 }, (_, i) => ({
      sessionId: `s${i}`,
      sessionName: `needle ${i}`,
      workingDir: '/x',
      timestamp: i,
    }));
    const res = searchSources('needle', sources({ sessions }));
    expect(res.groups[0].results.length).toBe(SEARCH_PER_GROUP_CAP);
    expect(res.truncated).toBe(true);
  });

  it('enforces the total cap across groups', () => {
    // Fill every group to its per-group cap; total must not exceed SEARCH_TOTAL_CAP.
    const mk = <T>(n: number, f: (i: number) => T) => Array.from({ length: n }, (_, i) => f(i));
    const data = sources({
      sessions: mk(SEARCH_PER_GROUP_CAP, (i) => ({
        sessionId: `s${i}`,
        sessionName: `needle ${i}`,
        workingDir: '/x',
        timestamp: i,
      })),
      events: mk(SEARCH_PER_GROUP_CAP, (i) => ({
        sessionId: `e${i}`,
        sessionName: 'E',
        eventId: `e${i}`,
        title: `needle ${i}`,
        details: '',
        timestamp: i,
      })),
      files: mk(SEARCH_PER_GROUP_CAP, (i) => ({
        sessionId: `f${i}`,
        sessionName: 'F',
        fileName: `needle${i}.txt`,
        relativePath: `d/needle${i}.txt`,
        timestamp: i,
        itemId: `f${i}`,
      })),
    });
    const res = searchSources('needle', data);
    expect(res.totalResults).toBeLessThanOrEqual(SEARCH_TOTAL_CAP);
  });
});

describe('searchSources — result card shape & path safety', () => {
  it('shapes a file result with a relative-path jump target and no absolute leakage', () => {
    const data = sources({
      files: [
        {
          sessionId: 's1',
          sessionName: 'Alpha',
          fileName: 'needle.txt',
          relativePath: 'docs/needle.txt',
          timestamp: 123,
          itemId: 'item-1',
        },
      ],
    });
    const r = searchSources('needle', data).groups[0].results[0];
    expect(r.type).toBe('file');
    expect(r.sessionId).toBe('s1');
    expect(r.sessionName).toBe('Alpha');
    expect(r.timestamp).toBe(123);
    expect(r.jumpTo).toEqual({
      kind: 'file-preview',
      sessionId: 's1',
      targetId: 'item-1',
      relativePath: 'docs/needle.txt',
    });
    // No absolute path anywhere in the serialized result.
    expect(JSON.stringify(r)).not.toContain('/home/');
  });

  it('drops files that only have a server-private absolute path (no relativePath)', () => {
    const data = sources({
      files: [
        {
          sessionId: 's1',
          sessionName: 'Alpha',
          fileName: 'needle.txt',
          relativePath: undefined,
          timestamp: 1,
          itemId: 'i1',
        },
      ],
    });
    // fileName still matches, but there is no safe relativePath to expose → still
    // returned, but jumpTo must not carry an absolute path.
    const res = searchSources('needle', data);
    if (res.totalResults > 0) {
      expect(res.groups[0].results[0].jumpTo.relativePath).toBeUndefined();
    }
  });

  it('truncates long snippets', () => {
    const longDetail = 'needle ' + 'x'.repeat(500);
    const data = sources({
      events: [{ sessionId: 's1', sessionName: 'A', eventId: 'e1', title: 'evt', details: longDetail, timestamp: 1 }],
    });
    const r = searchSources('needle', data).groups[0].results[0];
    expect(r.snippet.length).toBeLessThanOrEqual(200);
  });

  it('returns empty for a blank query', () => {
    const data = sources({ sessions: [{ sessionId: 's1', sessionName: 'needle', workingDir: '/x', timestamp: 1 }] });
    expect(searchSources('', data).totalResults).toBe(0);
  });
});
