import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const swSource = () => readFileSync(resolve(import.meta.dirname, '../src/web/public/sw.js'), 'utf8');

describe('service worker cache policy', () => {
  it('does not precache mutable HTML or unhashed app shell assets', () => {
    const source = swSource();
    const appShell = source.match(/const APP_SHELL = \[([\s\S]*?)\];/)?.[1] ?? '';

    expect(appShell).not.toContain("'/'");
    expect(appShell).not.toContain('/styles.css');
    expect(appShell).not.toContain('/mobile.css');
    expect(appShell).not.toContain('/app.js');
    expect(appShell).not.toContain('/settings-ui.js');
  });

  it('uses a bumped runtime cache and never stores HTML navigation responses', () => {
    const source = swSource();

    expect(source).toContain("const CACHE_NAME = 'codeman-runtime-v2'");
    expect(source).toContain("request.mode === 'navigate'");
    expect(source).toContain('isHtmlResponse(response)');
    expect(source).toContain('!isHtmlResponse(response)');
  });
});
