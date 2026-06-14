import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

function loadTabOverflowHelper() {
  const context = vm.createContext({ window: {}, globalThis: {} });
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'constants.js' });
  return (context.window as { CodemanTabOverflow: { shouldAutoWrapTabs: (input: unknown) => boolean } })
    .CodemanTabOverflow;
}

describe('tab overflow layout policy', () => {
  it('auto-wraps desktop tabs when their rendered width exceeds available tab space', () => {
    const helper = loadTabOverflowHelper();

    expect(
      helper.shouldAutoWrapTabs({
        deviceType: 'desktop',
        manualTwoRows: false,
        tabCount: 18,
        scrollWidth: 1400,
        clientWidth: 760,
      })
    ).toBe(true);
  });

  it('does not auto-wrap when manual tall tabs are enabled or on mobile/tablet', () => {
    const helper = loadTabOverflowHelper();

    expect(
      helper.shouldAutoWrapTabs({
        deviceType: 'desktop',
        manualTwoRows: true,
        tabCount: 18,
        scrollWidth: 1400,
        clientWidth: 760,
      })
    ).toBe(false);
    expect(
      helper.shouldAutoWrapTabs({
        deviceType: 'mobile',
        manualTwoRows: false,
        tabCount: 18,
        scrollWidth: 1400,
        clientWidth: 320,
      })
    ).toBe(false);
  });
});
