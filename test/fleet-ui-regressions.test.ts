import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

function cssRuleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? '';
}

class FakeClassList {
  private readonly classes = new Set<string>();

  add(...tokens: string[]) {
    tokens.forEach((token) => this.classes.add(token));
  }

  remove(...tokens: string[]) {
    tokens.forEach((token) => this.classes.delete(token));
  }

  contains(token: string) {
    return this.classes.has(token);
  }

  toggle(token: string, force?: boolean) {
    const shouldAdd = force ?? !this.classes.has(token);
    if (shouldAdd) this.classes.add(token);
    else this.classes.delete(token);
    return shouldAdd;
  }
}

class FakeElement {
  id = '';
  className = '';
  textContent = '';
  innerHTML = '';
  hidden = false;
  style: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  readonly classList = new FakeClassList();
  readonly dataset: Record<string, string> = {};
  private readonly attrs = new Map<string, string>();

  constructor(id = '') {
    this.id = id;
  }

  append(...nodes: FakeElement[]) {
    this.children.push(...nodes);
  }

  appendChild(node: FakeElement) {
    this.children.push(node);
    return node;
  }

  replaceChildren(...nodes: FakeElement[]) {
    this.children.length = 0;
    this.children.push(...nodes);
  }

  addEventListener() {
    // Events are not dispatched in these DOM-shape tests.
  }

  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
  }

  getAttribute(name: string) {
    return this.attrs.get(name) ?? null;
  }

  removeAttribute(name: string) {
    this.attrs.delete(name);
  }

  querySelectorAll() {
    return [];
  }
}

describe('fleet and settings UI regressions', () => {
  it('collapses the split grid when Single is clicked even if state says it is already single', () => {
    const CodemanApp = function CodemanApp(this: unknown) {};
    const grid = new FakeElement('fleetGrid');
    grid.classList.add('active');
    grid.setAttribute('data-layout', '4');
    const seg = new FakeElement('gridLayoutSeg');
    const elements: Record<string, FakeElement> = { fleetGrid: grid, gridLayoutSeg: seg };
    const context = vm.createContext({
      CodemanApp,
      document: { getElementById: (id: string) => elements[id] ?? null },
      MobileDetection: { getDeviceType: () => 'desktop' },
      console,
    });

    const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/fleet-tabs.js'), 'utf8');
    vm.runInContext(source, context, { filename: 'fleet-tabs.js' });
    const app = new (CodemanApp as any)();
    app._fleetGridLayout = 1;
    app._fleetGridPinned = [null];
    app._fleetGridTerms = new Map();
    app._fleetGridLru = new Map();

    app.setFleetGridLayout(1);

    expect(grid.classList.contains('active')).toBe(false);
    expect(grid.getAttribute('data-layout')).toBeNull();
  });

  it('resets the native renderer and forces resize before reloading when leaving split grid', () => {
    const CodemanApp = function CodemanApp(this: unknown) {};
    const grid = new FakeElement('fleetGrid');
    grid.classList.add('active');
    grid.setAttribute('data-layout', '4');
    const seg = new FakeElement('gridLayoutSeg');
    const elements: Record<string, FakeElement> = { fleetGrid: grid, gridLayoutSeg: seg };
    const context = vm.createContext({
      CodemanApp,
      document: { getElementById: (id: string) => elements[id] ?? null },
      MobileDetection: { getDeviceType: () => 'desktop' },
      console,
    });

    const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/fleet-tabs.js'), 'utf8');
    vm.runInContext(source, context, { filename: 'fleet-tabs.js' });
    const app = new (CodemanApp as any)();
    app.activeSessionId = 'session-1';
    app._fleetGridLayout = 4;
    app._fleetGridPinned = ['session-1', null, null, null];
    app._fleetGridTerms = new Map([['session-1', {}]]);
    app._fleetGridLru = new Map([['session-1', 1]]);
    app.closeFleetGridTerminal = (key: string) => {
      app.closedKey = key;
      app._fleetGridTerms.delete(key);
    };
    app.fitAddon = {
      fit: () => {
        app.fitCalled = true;
      },
    };
    app._disposeMainTerminalWebglAfterGrid = () => {
      app.webglDisposed = true;
    };
    app.selectSession = (id: string, options: unknown) => {
      app.selected = { id, options };
      return Promise.resolve();
    };

    app.setFleetGridLayout(1);

    expect(app.closedKey).toBe('session-1');
    expect(app.webglDisposed).toBe(true);
    expect(app.fitCalled).toBe(true);
    expect(app.selected).toEqual({
      id: 'session-1',
      options: { forceReload: true, forceResize: true },
    });
  });

  it('keeps local welcome history from rendering remote subdrive rows by default', async () => {
    const CodemanApp = function CodemanApp(this: unknown) {};
    const elements: Record<string, FakeElement> = {
      historySessions: new FakeElement('historySessions'),
      historyList: new FakeElement('historyList'),
      historyTitle: new FakeElement('historyTitle'),
    };
    const context = vm.createContext({
      CodemanApp,
      window: {},
      document: {
        documentElement: { dataset: { skin: 'daylight-blue' } },
        getElementById: (id: string) => elements[id] ?? null,
        createElement: (tag: string) => new FakeElement(tag),
      },
      console,
    });

    const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');
    vm.runInContext(source, context, { filename: 'terminal-ui.js' });
    const app = new (CodemanApp as any)();
    app.cases = [{ name: 'local', path: '/Users/ming/project/local' }];
    app._welcomeDeviceId = 'local';
    app._fetchHistorySessions = async () => [
      {
        sessionId: 'local-session-123',
        workingDir: '/Users/ming/project/local',
        projectKey: 'local',
        firstPrompt: 'Local work',
        lastModified: '2026-07-04T06:00:00.000Z',
        sizeBytes: 2048,
      },
    ];
    app._fetchRemoteResumeRows = async () => [
      {
        deviceId: 'macmini',
        deviceName: 'macmini',
        candidate: {
          sessionId: 'remote-session-456',
          workingDir: '/Users/ming/subdrive/remote',
          title: 'Remote subdrive session',
          updatedAt: Date.parse('2026-07-04T07:00:00.000Z'),
        },
      },
    ];

    await app.loadHistorySessions();

    const classNames = elements.historyList.children.map((child) => child.className);
    expect(classNames).toContain('history-item');
    expect(classNames.some((name) => name.includes('history-item-remote'))).toBe(false);
  });

  it('removes a stopped fleet session from the cached UI state immediately', async () => {
    const CodemanApp = function CodemanApp(this: unknown) {};
    const context = vm.createContext({ CodemanApp, console });
    const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/fleet-tabs.js'), 'utf8');
    vm.runInContext(source, context, { filename: 'fleet-tabs.js' });

    const app = new (CodemanApp as any)();
    const key = 'macmini:session-1';
    app.fleetTabs = new Map([
      [
        key,
        {
          deviceId: 'macmini',
          sessionId: 'session-1',
          deviceName: 'macmini',
          sessionLabel: 'codeman',
          online: true,
        },
      ],
    ]);
    app._fleetState = {
      devices: [{ id: 'macmini', status: 'online', activeSessionCount: 1 }],
      sessions: [{ deviceId: 'macmini', id: 'session-1', name: 'codeman' }],
      sessionTabs: [{ key, deviceId: 'macmini', sessionId: 'session-1' }],
    };
    app.fleetStopSession = async () => ({ ok: true });
    app._fullRenderSessionTabs = () => {
      app.rendered = true;
    };
    app._renderFleetPanelIfOpen = () => {
      app.panelRendered = true;
    };
    app.renderWelcomeActiveSessions = () => {
      app.activeRendered = true;
    };
    app.showToast = () => {};

    await app.stopFleetSession(key);

    expect(app.fleetTabs.has(key)).toBe(false);
    expect(app._fleetState.sessions).toHaveLength(0);
    expect(app._fleetState.sessionTabs).toHaveLength(0);
    expect(app._fleetState.devices[0].activeSessionCount).toBe(0);
    expect(app.rendered).toBe(true);
    expect(app.panelRendered).toBe(true);
    expect(app.activeRendered).toBe(true);
  });

  it('hides a fleet tab without deleting the cached active session and refreshes attach surfaces', () => {
    const CodemanApp = function CodemanApp(this: unknown) {};
    const context = vm.createContext({ CodemanApp, localStorage: { setItem() {} }, console });
    const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/fleet-tabs.js'), 'utf8');
    vm.runInContext(source, context, { filename: 'fleet-tabs.js' });

    const app = new (CodemanApp as any)();
    const key = 'macmini:session-1';
    app.fleetTabs = new Map([
      [
        key,
        {
          deviceId: 'macmini',
          sessionId: 'session-1',
          deviceName: 'macmini',
          sessionLabel: 'codeman',
          online: true,
        },
      ],
    ]);
    app._fleetHidden = new Set();
    app._fleetState = {
      devices: [{ id: 'macmini', status: 'online', activeSessionCount: 1 }],
      sessions: [{ deviceId: 'macmini', id: 'session-1', name: 'codeman' }],
      sessionTabs: [{ key, deviceId: 'macmini', sessionId: 'session-1' }],
    };
    app.activeSessionId = 'local-session';
    app.sessionOrder = ['local-session'];
    app.sessions = new Map([['local-session', { id: 'local-session' }]]);
    app._fullRenderSessionTabs = () => {
      app.tabsRendered = true;
    };
    app._renderFleetPanelIfOpen = () => {
      app.panelRendered = true;
    };
    app.renderWelcomeActiveSessions = () => {
      app.activeRendered = true;
    };
    app._updateFleetBadge = () => {
      app.badgeUpdated = true;
    };

    app.closeFleetTab(key);

    expect(app.fleetTabs.has(key)).toBe(false);
    expect(app._fleetHidden.has(key)).toBe(true);
    expect(app._fleetState.sessions).toHaveLength(1);
    expect(app._fleetState.sessionTabs).toHaveLength(1);
    expect(app._fleetState.devices[0].activeSessionCount).toBe(1);
    expect(app.tabsRendered).toBe(true);
    expect(app.panelRendered).toBe(true);
    expect(app.activeRendered).toBe(true);
    expect(app.badgeUpdated).toBe(true);
  });

  it('renders remote tabs with prominent device, remark, and official provider icon structure', () => {
    const CodemanApp = function CodemanApp(this: unknown) {};
    const context = vm.createContext({
      CodemanApp,
      escapeHtml: (value: unknown) =>
        String(value)
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&#039;'),
      codemanModeBadgeHtml: (mode: string) =>
        `<span class="tab-mode tab-mode-logo tab-mode-openai" title="${mode}"><svg aria-hidden="true"></svg></span>`,
      codemanDevicePillHtml: (deviceName: string, kind: string) =>
        `<span class="tab-device-pill tab-device-${kind}"><span>${deviceName}</span></span>`,
      console,
    });
    const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/fleet-tabs.js'), 'utf8');
    vm.runInContext(source, context, { filename: 'fleet-tabs.js' });

    const app = new (CodemanApp as any)();
    const html = app._fleetTabHtml('pc-e5:s1', {
      deviceId: 'pc-e5',
      sessionId: 's1',
      deviceName: 'pc-e5',
      sessionLabel: 'xianmi-assistant',
      remark: '打包机',
      mode: 'codex',
      status: 'busy',
      online: true,
      workingDir: '/Users/ming/project',
    });

    expect(html).toContain('tab-device-pill tab-device-remote');
    expect(html).toContain('pc-e5');
    expect(html).toContain('tab-mode-logo tab-mode-openai');
    expect(html).toContain('tab-remark');
    expect(html).toContain('打包机');
    expect(html).toContain('tab-session-secondary');
    expect(html).toContain('xianmi-assistant');
    expect(html).not.toContain('>cx</span>');
  });

  it('routes remote tab close through the stop-or-hide confirmation modal', () => {
    const appSource = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
    const html = readFileSync(resolve(import.meta.dirname, '../src/web/public/index.html'), 'utf8');

    expect(appSource).toContain('closeConfirmRemoteNote');
    expect(appSource).not.toContain('Remote fleet tab: close = hide locally (no confirm, session keeps running).');
    expect(appSource).not.toContain('this.closeFleetTab(sessionId);\n      return;');
    expect(html).toContain('id="closeConfirmRemoteNote"');
  });

  it('treats forced session resize as a redraw-worthy resize before buffer fetch', () => {
    const appSource = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
    const terminalSource = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');

    expect(appSource).toContain('const forceResize = options?.forceResize === true');
    expect(appSource).toContain('this.sendResize(sessionId, { forceHttp: true, force: forceResize })');
    expect(terminalSource).toContain('const changed = options.force === true ||');
  });

  it('keeps main-terminal WebGL opt-in so refresh uses the stable renderer by default', () => {
    const terminalSource = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');

    expect(terminalSource).toContain("const forceWebGL = _params.get('webgl') === 'force';");
    expect(terminalSource).toContain('!forceWebGL');
    expect(terminalSource).toContain('WebGL disabled by default');
  });

  it('adds a welcome active-session section for attaching to online sessions', () => {
    const html = readFileSync(resolve(import.meta.dirname, '../src/web/public/index.html'), 'utf8');
    const terminalSource = readFileSync(resolve(import.meta.dirname, '../src/web/public/terminal-ui.js'), 'utf8');

    expect(html).toContain('id="welcomeActiveSessions"');
    expect(html).toContain('id="welcomeActiveSessionList"');
    expect(terminalSource).toContain('renderWelcomeActiveSessions');
    expect(terminalSource).toContain('openFleetSessionTab');
    expect(terminalSource).toContain('selectSession');
  });

  it('exposes Codex on the welcome run surface', () => {
    const html = readFileSync(resolve(import.meta.dirname, '../src/web/public/index.html'), 'utf8');

    expect(html).toContain('welcome-btn-codex');
    expect(html).toContain("quickStartWithDir('codex')");
    expect(html).toContain('Run Codex');
  });

  it('uses custom controls for session-list position and quick-start working-dir candidates', () => {
    const html = readFileSync(resolve(import.meta.dirname, '../src/web/public/index.html'), 'utf8');
    const quickStartDirModal =
      html.match(/<div class="modal" id="quickStartDirModal">([\s\S]*?)<!-- Working-directory browser/)?.[1] ?? '';

    expect(html).not.toContain('<select id="appSettingsSessionListPosition"');
    expect(html).toContain('id="appSettingsSessionListPositionControl"');
    expect(html).toContain('type="hidden" id="appSettingsSessionListPosition"');
    expect(quickStartDirModal).not.toContain('<datalist');
    expect(quickStartDirModal).not.toContain('list="quickStartDirCandidates"');
    expect(quickStartDirModal).toContain('id="quickStartDirCandidates"');
  });

  it('keeps the left session-list layout usable on phones with a drawer control', () => {
    const html = readFileSync(resolve(import.meta.dirname, '../src/web/public/index.html'), 'utf8');
    const css = readFileSync(resolve(import.meta.dirname, '../src/web/public/styles.css'), 'utf8');
    const appSource = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
    const settingsSource = readFileSync(resolve(import.meta.dirname, '../src/web/public/settings-ui.js'), 'utf8');

    expect(html).toContain('id="sessionListToggleBtn"');
    expect(html).toContain('onclick="app.toggleSessionListDrawer()"');
    expect(html).toContain('id="sessionListBackdrop"');
    expect(html).not.toContain('ignored on phones');
    expect(css).toContain('body.session-list-left.device-mobile #sessionTabs');
    expect(css).toContain('body.session-list-left.session-list-drawer-open.device-mobile .session-list-sidebar');
    expect(appSource).toContain('toggleSessionListDrawer');
    expect(appSource).toContain('closeSessionListDrawer');
    expect(settingsSource).not.toContain('phone ignores the setting');
  });

  it('lays out App Settings tabs without horizontal scroll overflow', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../src/web/public/styles.css'), 'utf8');
    const appSettingsTabs = cssRuleBody(css, '#appSettingsModal .modal-tabs');

    expect(appSettingsTabs).toContain('grid-template-columns');
    expect(appSettingsTabs).not.toContain('overflow-x: auto');
  });
});
