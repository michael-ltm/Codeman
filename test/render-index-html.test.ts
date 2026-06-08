/**
 * WebServer.renderIndexHtml — server-side gating of the index shell:
 *  - multi-monitor button reveal (stable class-marker, not brittle copy match)
 *  - solo (/session/:id) global injection + escaping, and settings skipped
 *  - gesture overlay availability vs. enablement (CODEMAN_GESTURE + setting)
 *  - settings read FRESH so a post-save reload doesn't render stale state
 *
 * WebServer's constructor only assigns fields (no port bind), so we construct it
 * directly, swap in a tiny indexHtmlTemplate, and stub readSettings to avoid disk.
 *
 * Port: N/A (no server start).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { WebServer } from '../src/web/server.js';

const TEMPLATE = [
  '<head>',
  '<title>Codeman</title>',
  '</head>',
  '<body>',
  '<button class="btn-icon-header btn-multimonitor btn-multimonitor--hidden" aria-label="Open Codeman across all displays"></button>',
  '</body>',
].join('\n');

function makeServer(settings: Record<string, unknown> = {}) {
  const server = new WebServer(0, false, true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).indexHtmlTemplate = TEMPLATE;
  const readSettings = vi.fn(async () => settings);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).readSettings = readSettings;
  return { server, readSettings };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const render = (server: WebServer, solo?: string): Promise<string> => (server as any).renderIndexHtml(solo);

const ORIG_GESTURE = process.env.CODEMAN_GESTURE;
afterEach(() => {
  if (ORIG_GESTURE === undefined) delete process.env.CODEMAN_GESTURE;
  else process.env.CODEMAN_GESTURE = ORIG_GESTURE;
});

describe('WebServer.renderIndexHtml', () => {
  it('keeps the multi-monitor button hidden by default and reads settings FRESH', async () => {
    const { server, readSettings } = makeServer({});
    const html = await render(server);
    expect(html).toContain('btn-multimonitor--hidden');
    // forceFresh=true — fixes the post-save reload race against the 2s cache.
    expect(readSettings).toHaveBeenCalledWith(true);
  });

  it('reveals the multi-monitor button when showMultiMonitorButton is set', async () => {
    const { server } = makeServer({ showMultiMonitorButton: true });
    const html = await render(server);
    expect(html).not.toContain('btn-multimonitor--hidden');
    expect(html).toContain('btn-multimonitor"'); // class list still present, only the marker stripped
  });

  it('injects the solo global and skips settings for a /session/:id window', async () => {
    const { server, readSettings } = makeServer({ showMultiMonitorButton: true });
    const html = await render(server, 'sess-123');
    expect(html).toContain('window.__CODEMAN_SOLO__="sess-123"');
    expect(readSettings).not.toHaveBeenCalled();
    // Solo skips settings, so the button is NOT revealed even though the setting is on.
    expect(html).toContain('btn-multimonitor--hidden');
  });

  it('escapes the solo id so it cannot break out of the inline <script>', async () => {
    const { server } = makeServer({});
    const html = await render(server, 'a</script><b>');
    expect(html).not.toContain('</script><b>');
    expect(html).toContain('\\u003c');
  });

  it('exposes gesture availability but injects the bundle only when enabled', async () => {
    process.env.CODEMAN_GESTURE = '1';
    let { server } = makeServer({ gestureControlEnabled: false });
    let html = await render(server);
    expect(html).toContain('window.__codemanGestureAvailable=true');
    expect(html).not.toContain('gesture-codeman.js');

    ({ server } = makeServer({ gestureControlEnabled: true }));
    html = await render(server);
    expect(html).toContain('window.__codemanGestureAvailable=true');
    expect(html).toContain('gesture-codeman.js');
  });

  it('does not expose gesture at all when CODEMAN_GESTURE is unset', async () => {
    delete process.env.CODEMAN_GESTURE;
    const { server } = makeServer({ gestureControlEnabled: true });
    const html = await render(server);
    expect(html).not.toContain('__codemanGestureAvailable');
    expect(html).not.toContain('gesture-codeman.js');
  });
});
