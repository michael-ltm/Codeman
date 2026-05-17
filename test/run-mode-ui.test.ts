/**
 * @fileoverview Unit tests for the Codex run-mode UI surface in session-ui.js /
 * settings-ui.js / index.html. Loads the browser modules into a vm sandbox (no
 * real DOM) and exercises run-mode selection + Codex quick-start wiring.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

function loadRunModeHarness() {
  const elements: Record<string, any> = {};
  const storage = new Map<string, string>();
  const CodemanApp = function CodemanApp(this: any) {};

  const context = vm.createContext({
    CodemanApp,
    VoiceInput: {},
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    document: {
      getElementById: (id: string) => elements[id] ?? null,
    },
    console,
  });

  const settingsUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/settings-ui.js'), 'utf8');
  const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
  vm.runInContext(settingsUi, context, { filename: 'settings-ui.js' });
  vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });

  const runModeMenu = { classList: { remove: () => {} } };
  const gearBtn = { className: '' };
  const runBtn = { className: '', nextElementSibling: gearBtn };
  const runBtnLabel = { textContent: '' };
  elements.runModeMenu = runModeMenu;
  elements.runBtn = runBtn;
  elements.runBtnLabel = runBtnLabel;

  const app = new (CodemanApp as any)();
  app.loadAppSettingsFromStorage = () => ({});
  app.saveAppSettingsToStorage = () => {};
  app._apiPut = () => Promise.resolve();

  return { app, storage, runBtnLabel };
}

describe('run mode UI', () => {
  it('updates the visible mode when selecting Claude after server sync set Codex', async () => {
    const { app, storage, runBtnLabel } = loadRunModeHarness();

    storage.set('codeman_runMode', 'claude');
    await app.loadAppSettingsFromServer(Promise.resolve({ runMode: 'codex' }));
    expect(app.runMode).toBe('codex');
    expect(runBtnLabel.textContent).toBe('Run CX');

    app.setRunMode('claude');

    expect(app.runMode).toBe('claude');
    expect(runBtnLabel.textContent).toBe('Run');
  });

  it('accepts Gemini mode from server sync and updates the run button label', async () => {
    const { app, storage, runBtnLabel } = loadRunModeHarness();

    storage.set('codeman_runMode', 'claude');
    await app.loadAppSettingsFromServer(Promise.resolve({ runMode: 'gemini' }));

    expect(app.runMode).toBe('gemini');
    expect(runBtnLabel.textContent).toBe('Run GM');
  });
});

describe('Codex quick start settings', () => {
  it('renders Codex CLI settings in a dedicated app settings tab', () => {
    const html = readFileSync(resolve(import.meta.dirname, '../src/web/public/index.html'), 'utf8');

    expect(html).toContain('data-tab="settings-codex">Codex CLI</button>');

    const claudeTab = html.match(
      /<div class="modal-tab-content hidden" id="settings-claude">([\s\S]*?)<!-- Codex CLI Tab -->/
    );
    expect(claudeTab?.[1]).not.toContain('appSettingsCodexDangerouslyBypassApprovals');

    const codexTab = html.match(
      /<div class="modal-tab-content hidden" id="settings-codex">([\s\S]*?)<\/div>\s*<!-- Models Tab -->/
    );
    expect(codexTab?.[1]).toContain('appSettingsCodexDangerouslyBypassApprovals');
    expect(codexTab?.[1]).not.toContain('appSettingsCodexRenderMode');
  });

  it('passes global Codex settings into quick-start config for new sessions', async () => {
    const elements: Record<string, any> = {
      quickStartCase: { value: 'codex-case' },
    };
    const requests: Array<{ url: string; body?: any }> = [];
    const CodemanApp = function CodemanApp(this: any) {};

    const context = vm.createContext({
      CodemanApp,
      localStorage: {
        getItem: () => null,
        setItem: () => {},
      },
      document: {
        getElementById: (id: string) => elements[id] ?? null,
      },
      // Mock responses use the real wire shape: the global preSerialization hook in
      // server.ts wraps route payloads into the { success, data } envelope.
      fetch: async (url: string, init?: { body?: string }) => {
        requests.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
        if (url === '/api/codex/status') return { json: async () => ({ success: true, data: { available: true } }) };
        if (url === '/api/quick-start') return { json: async () => ({ success: true, data: { sessionId: 'sess-1' } }) };
        throw new Error(`unexpected fetch: ${url}`);
      },
      console,
    });

    const sessionUi = readFileSync(resolve(import.meta.dirname, '../src/web/public/session-ui.js'), 'utf8');
    vm.runInContext(sessionUi, context, { filename: 'session-ui.js' });

    const app = new (CodemanApp as any)();
    app.terminal = { clear: () => {}, writeln: () => {}, focus: () => {} };
    app.loadAppSettingsFromStorage = () => ({
      codexDangerouslyBypassApprovals: true,
    });
    app.getCaseSettings = () => ({});
    app.buildEnvOverrides = () => ({});
    const selected: string[] = [];
    app.selectSession = async (id: string) => {
      selected.push(id);
    };

    await app.runCodex();

    expect(requests.find((req) => req.url === '/api/quick-start')?.body).toMatchObject({
      caseName: 'codex-case',
      mode: 'codex',
      codexConfig: { dangerouslyBypassApprovals: true, renderMode: 'hybrid' },
    });
    expect(selected).toEqual(['sess-1']);
  });
});
