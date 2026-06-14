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

  it('respects the boundary conditions (exact fit, +1 tolerance, and tabCount < 2)', () => {
    const helper = loadTabOverflowHelper();
    const base = { deviceType: 'desktop' as const, manualTwoRows: false, tabCount: 6 };

    // Exact fit: no overflow, no wrap.
    expect(helper.shouldAutoWrapTabs({ ...base, scrollWidth: 800, clientWidth: 800 })).toBe(false);
    // Within the +1 sub-pixel tolerance: still no wrap.
    expect(helper.shouldAutoWrapTabs({ ...base, scrollWidth: 801, clientWidth: 800 })).toBe(false);
    // 2px over: wrap.
    expect(helper.shouldAutoWrapTabs({ ...base, scrollWidth: 802, clientWidth: 800 })).toBe(true);
    // A single overflowing tab must not wrap (need at least 2 to form a second row).
    expect(helper.shouldAutoWrapTabs({ ...base, tabCount: 1, scrollWidth: 1400, clientWidth: 760 })).toBe(false);
  });
});
