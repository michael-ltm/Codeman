import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadTerminalUiHarness() {
  const CodemanApp = function CodemanApp(this: any) {};
  let now = 1_000;
  const context = vm.createContext({
    window: {},
    CodemanApp,
    console: { warn: vi.fn(), log: vi.fn() },
    _crashDiag: { log: vi.fn() },
    performance: { now: () => now },
    requestAnimationFrame: (_fn: () => void) => 1,
    setTimeout: (_fn: () => void) => 1,
    Blob: function Blob() {},
    URL: {
      createObjectURL: () => 'blob:yield',
      revokeObjectURL: () => {},
    },
    Worker: function Worker(this: any) {
      this.postMessage = () => {};
    },
    MobileDetection: {
      isTouchDevice: () => true,
    },
    DEC_SYNC_STRIP_RE: /\x1b\[\?2026[hl]/g,
    TERMINAL_CHUNK_SIZE: 32 * 1024,
  });

  const code = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
  vm.runInContext(code, context, { filename: 'terminal-ui.js' });

  const app = new (CodemanApp as any)();
  return {
    app,
    setNow: (value: number) => {
      now = value;
    },
  };
}

function createElementHarness() {
  const listeners = new Map<string, (ev: any) => void>();
  return {
    element: {
      addEventListener: vi.fn((type: string, listener: (ev: any) => void) => {
        listeners.set(type, listener);
      }),
    },
    dispatch(type: string, event: any) {
      listeners.get(type)?.(event);
    },
  };
}

describe('terminal touch tap mouse guard', () => {
  it('suppresses browser trusted compatibility mouse events during the tap window', () => {
    const { app } = loadTerminalUiHarness();
    const { element, dispatch } = createElementHarness();
    app.terminal = { element };

    app._installMobileTapMouseGuard();
    app._suppressTrustedTapMouseEvents();

    const event = {
      isTrusted: true,
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    };
    dispatch('mousedown', event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
  });

  it('allows the app synthetic mouse event through the tap window', () => {
    const { app } = loadTerminalUiHarness();
    const { element, dispatch } = createElementHarness();
    app.terminal = { element };

    app._installMobileTapMouseGuard();
    app._suppressTrustedTapMouseEvents();

    const event = {
      isTrusted: false,
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    };
    dispatch('mousedown', event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
  });

  it('allows trusted mouse events after the tap window expires', () => {
    const { app, setNow } = loadTerminalUiHarness();
    const { element, dispatch } = createElementHarness();
    app.terminal = { element };

    app._installMobileTapMouseGuard();
    app._suppressTrustedTapMouseEvents();
    setNow(2_000);

    const event = {
      isTrusted: true,
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    };
    dispatch('mousedown', event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
  });
});
