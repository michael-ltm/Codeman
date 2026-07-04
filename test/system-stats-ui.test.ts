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
    contains() {
      return false;
    },
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

  it('fetches stats from the selected fleet device when a remote device is selected', async () => {
    const CodemanApp = function CodemanApp(this: unknown) {};
    const elements: Record<string, FakeElement> = {
      welcomeOverlay: new FakeElement(),
      headerSystemStats: new FakeElement(),
      statCpu: new FakeElement(),
      statCpuBar: new FakeElement(),
      statMem: new FakeElement(),
      statMemBar: new FakeElement(),
    };
    elements.welcomeOverlay.classList.contains = (cls: string) => cls === 'visible';
    const context = vm.createContext({
      CodemanApp,
      document: { getElementById: (id: string) => elements[id] ?? null },
      fetch: async () => {
        throw new Error('local stats endpoint should not be used');
      },
      console,
      setInterval,
      clearInterval,
    });

    const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/panels-ui.js'), 'utf8');
    vm.runInContext(source, context, { filename: 'panels-ui.js' });
    const app = new (CodemanApp as any)();
    app.$ = (id: string) => elements[id] ?? null;
    app._fleetState = {
      devices: [{ id: 'macmini', name: 'Mac mini', status: 'online' }],
      sessions: [],
      sessionTabs: [],
    };
    app._welcomeDeviceId = 'macmini';
    let requestedDeviceId = '';
    app.fleetSystemStats = async (deviceId: string) => {
      requestedDeviceId = deviceId;
      return { cpu: 22, memory: { usedMB: 4096, totalMB: 8192, percent: 50 } };
    };

    await app.fetchSystemStats();

    expect(requestedDeviceId).toBe('macmini');
    expect(elements.statCpu.textContent).toBe('22%');
    expect(elements.statMem.textContent).toBe('4.0G');
  });
});
