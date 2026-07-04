import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

class FakeElement {
  textContent = '';
  style: Record<string, string> = {};
  readonly classList = {
    add() {},
    remove() {},
  };
}

describe('system stats header UI', () => {
  it('starts polling when the header stats control is visible', () => {
    const settingsSource = readFileSync(resolve(import.meta.dirname, '../src/web/public/settings-ui.js'), 'utf8');

    expect(settingsSource).toContain('syncSystemStatsPolling');
  });

  it('unwraps realtime system stats before rendering CPU and memory', async () => {
    const CodemanApp = function CodemanApp(this: unknown) {};
    const elements: Record<string, FakeElement> = {
      headerSystemStats: new FakeElement(),
      statCpu: new FakeElement(),
      statCpuBar: new FakeElement(),
      statMem: new FakeElement(),
      statMemBar: new FakeElement(),
    };
    const context = vm.createContext({
      CodemanApp,
      document: { getElementById: (id: string) => elements[id] ?? null },
      fetch: async () => ({
        json: async () => ({
          success: true,
          data: { cpu: 37, memory: { usedMB: 8192, totalMB: 16384, percent: 50 } },
        }),
      }),
      console,
      setInterval,
      clearInterval,
    });

    const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/panels-ui.js'), 'utf8');
    vm.runInContext(source, context, { filename: 'panels-ui.js' });
    const app = new (CodemanApp as any)();
    app.$ = (id: string) => elements[id] ?? null;

    await app.fetchSystemStats();

    expect(elements.statCpu.textContent).toBe('37%');
    expect(elements.statCpuBar.style.width).toBe('37%');
    expect(elements.statMem.textContent).toBe('8.0G');
    expect(elements.statMemBar.style.width).toBe('50%');
  });
});
