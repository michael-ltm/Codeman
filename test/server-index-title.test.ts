/**
 * Verifies that WebServer templates the `<title>` tag in the served
 * index.html with the hostname-aware `codeman:<host>` window title
 * (feature #82). The title must:
 *   - default to `codeman:<os.hostname()>` when no override is supplied
 *   - honor a custom `titleHostname` passed via the constructor (CLI flag
 *     `--title-hostname <host>` plumbs through to here)
 *   - HTML-escape the hostname so a value like `<script>foo</script>`
 *     can't break out of the title tag
 *   - replace the bare `<title>Codeman</title>` literal exactly once
 *   - leave the rest of the document byte-for-byte identical to the
 *     template on disk
 *
 * Strategy: construct WebServer with port 0 / testMode (no network
 * activity until start()) and call the private `renderIndexHtml()`
 * method directly. The Fastify `/` and `/index.html` route handlers
 * are one-liners that call exactly this method (server.ts:539-544),
 * so testing the render function covers both endpoints without
 * needing to listen on a port.
 *
 * Port: N/A (no server start)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname as osHostname } from 'node:os';
import { WebServer } from '../src/web/server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexHtmlPath = join(__dirname, '..', 'src', 'web', 'public', 'index.html');
const rawTemplate = readFileSync(indexHtmlPath, 'utf-8');

function render(host?: string): string {
  const server = new WebServer(0, false, true, host);
  return (server as unknown as { renderIndexHtml: () => string }).renderIndexHtml();
}

describe('WebServer index.html <title> templating (#82)', () => {
  it('substitutes the bare <title>Codeman</title> with codeman:<host>', () => {
    const html = render('laptop');
    expect(html).toContain('<title>codeman:laptop</title>');
    expect(html).not.toContain('<title>Codeman</title>');
  });

  it('defaults to os.hostname() when no titleHostname is supplied', () => {
    const html = render();
    const expected = `<title>codeman:${osHostname()}</title>`;
    expect(html).toContain(expected);
  });

  it('treats an empty-string titleHostname as "not supplied" and falls back to os.hostname()', () => {
    // CLI normally guarantees a non-empty string, but the constructor's
    // `titleHostname || getHostname()` guard makes empty fall through —
    // pin that behavior so a future refactor doesn't accidentally ship
    // a `<title>codeman:</title>` to users.
    const html = render('');
    expect(html).toMatch(/<title>codeman:.+<\/title>/);
    expect(html).not.toContain('<title>codeman:</title>');
  });

  it('HTML-escapes < > & in the hostname so it cannot break out of the title tag', () => {
    const html = render('<script>alert(1)</script>');
    expect(html).toContain('<title>codeman:&lt;script&gt;alert(1)&lt;/script&gt;</title>');
    // The raw closing </title> from the injected payload must NOT appear
    // outside the actual title element — escape-then-substitute prevents
    // an attacker-controlled hostname from terminating the tag early.
    expect(html).not.toContain('<script>alert(1)</script></title>');
  });

  it('escapes an ampersand without double-encoding existing entities', () => {
    // The escaper replaces & first, then < and >. A hostname that already
    // contains a literal `&` should render as `&amp;` once, not `&amp;amp;`.
    const html = render('a&b');
    expect(html).toContain('<title>codeman:a&amp;b</title>');
    expect(html).not.toContain('&amp;amp;');
  });

  it('only substitutes the <title> tag — the rest of the template is byte-for-byte identical', () => {
    const html = render('laptop');
    const beforeTitle = rawTemplate.split('<title>Codeman</title>')[0];
    const afterTitle = rawTemplate.split('<title>Codeman</title>')[1];
    expect(html.startsWith(beforeTitle)).toBe(true);
    expect(html.endsWith(afterTitle)).toBe(true);
    // Sanity check: length differs only by the title swap.
    const expectedDelta = `<title>codeman:laptop</title>`.length - `<title>Codeman</title>`.length;
    expect(html.length - rawTemplate.length).toBe(expectedDelta);
  });

  it('replaces the <title> placeholder exactly once', () => {
    const html = render('laptop');
    // Defense against a future regression where the template gains a
    // second `<title>Codeman</title>` (e.g. inside a <noscript>) and only
    // the first gets templated — would leave a stale literal in the served
    // HTML that overrides the correct one in some renderers.
    const occurrencesOfNew = html.split('<title>codeman:laptop</title>').length - 1;
    const occurrencesOfOld = html.split('<title>Codeman</title>').length - 1;
    expect(occurrencesOfNew).toBe(1);
    expect(occurrencesOfOld).toBe(0);
  });

  it('two WebServer instances on different hostnames render distinct titles', () => {
    const htmlA = render('host-a');
    const htmlB = render('host-b');
    expect(htmlA).toContain('<title>codeman:host-a</title>');
    expect(htmlB).toContain('<title>codeman:host-b</title>');
    expect(htmlA).not.toContain('host-b');
    expect(htmlB).not.toContain('host-a');
  });
});
