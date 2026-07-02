/**
 * @fileoverview Fleet Dashboard core UI, mixed into CodemanApp.prototype.
 *
 * Renders the three-zone fleet view (device list / global tab strip / focused
 * single terminal) and drives remote terminals over the Task 11 browser WS
 * endpoint. Task 14 layers a split-grid (1 / 2 / 2x2 tiles) on top of the
 * primitives produced here: each tile pins one session key and owns an
 * independent openFleetTerminal() instance, so input routing per tile is
 * guaranteed by the same per-socket closure discipline as the single-tile
 * view — there is no shared/multiplexed WS.
 *
 * Security discipline: every string that originates from a remote node (device
 * names, hostnames, session labels, working dirs, tab titles, pairing/join
 * strings) is passed through escapeHtml() before it touches innerHTML. Each
 * terminal's input handler is bound to that terminal's own WebSocket via a
 * closure, so keystrokes for one device can never be delivered to another.
 *
 * Produced on CodemanApp.prototype:
 *   initFleetDashboard, showFleetDashboard, hideFleetDashboard,
 *   refreshFleetState, renderFleetDevices, renderFleetTabs, selectFleetTab,
 *   openFleetTerminal, closeFleetTerminal, _fleetState, _fleetTerms,
 *   setFleetLayout, pinFleetTab, unpinFleetTile, _fleetLayout, _fleetPinned.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js (CodemanApp), fleet-api.js (listFleet/…), constants.js (escapeHtml)
 * @dependency vendored Terminal + FitAddon (public/vendor); optional WebglAddon
 * @loadorder after fleet-api.js
 */

Object.assign(CodemanApp.prototype, {
  // ─────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────

  /**
   * One-time bootstrap: allocate state, wire static controls, fetch the first
   * fleet snapshot, and decide whether the dashboard should own the first
   * screen. The central always registers itself as device 'local', so the
   * first-screen check only counts REMOTE devices — otherwise the dashboard
   * would unconditionally preempt the normal local UI on every instance.
   */
  async initFleetDashboard() {
    this._fleetTerms = new Map();
    this._fleetState = null;
    this._fleetSelectedKey = null;
    this._fleetSelectedDeviceId = null;
    this._fleetShowHistory = false;
    this._fleetHiddenTabKeys = new Set();
    this._fleetShown = false;
    this._fleetPairTimer = null;
    // Task 14 split-grid state: _fleetLayout is the slot count (1/2/4);
    // _fleetPinned[i] is the session key occupying slot i (or null); _fleetLru
    // tracks last-use timestamps per key for the ≤6-instance eviction rule.
    this._fleetLayout = 1;
    this._fleetPinned = [null];
    this._fleetLru = new Map();
    this._fleetFocusedTileIndex = 0;
    this._wireFleetControls();
    try {
      this._fleetState = await this.listFleet();
    } catch {
      return;
    }
    if (!this._fleetState) return;
    const devices = this._fleetState.devices || [];
    const hasRemote = devices.some((d) => d.id !== 'local');
    if (hasRemote || window.__CODEMAN_FLEET_DASHBOARD__) this.showFleetDashboard();
  },

  /** Attach delegated + button listeners exactly once (survives re-renders). */
  _wireFleetControls() {
    if (this._fleetControlsWired) return;
    this._fleetControlsWired = true;
    const on = (id, handler) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('click', handler);
    };
    on('fleet-new-session-btn', () => this.openFleetNewSessionForm());
    on('fleet-pair-btn', () => this.openFleetPairingDrawer());
    on('fleet-empty-pair-btn', () => this.openFleetPairingDrawer());
    on('fleet-back-local-btn', () => this.hideFleetDashboard());

    const devices = document.getElementById('fleet-devices');
    if (devices) devices.addEventListener('click', (e) => this._onFleetDevicesClick(e));
    const tabs = document.getElementById('fleet-tabs');
    if (tabs) tabs.addEventListener('click', (e) => this._onFleetTabsClick(e));
    const sessions = document.getElementById('fleet-sessions');
    if (sessions) sessions.addEventListener('click', (e) => this._onFleetSessionsClick(e));
    const drawer = document.getElementById('fleet-pair-drawer');
    if (drawer) drawer.addEventListener('click', (e) => this._onFleetPairDrawerClick(e));

    // Task 14: layout toolbar (1 / 2 / 2x2) and grid tile interactions.
    const layoutToolbar = document.getElementById('fleet-layout-toolbar');
    if (layoutToolbar) {
      layoutToolbar.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-layout-btn]');
        if (!btn) return;
        this.setFleetLayout(Number(btn.dataset.layoutBtn));
      });
    }
    const termArea = document.getElementById('fleet-term-area');
    if (termArea) termArea.addEventListener('click', (e) => this._onFleetTermAreaClick(e));
    this._updateLayoutToolbar();
  },

  /** Reveal the dashboard and hide (but never destroy) the local session view. */
  showFleetDashboard() {
    const dash = document.getElementById('fleet-dashboard');
    if (!dash) return;
    const localRoot = document.querySelector('.app');
    if (localRoot) localRoot.style.display = 'none';
    dash.classList.remove('hidden');
    this._fleetShown = true;
    this.renderFleetDevices();
    this._renderFleetSessions();
    this.renderFleetTabs();
    // Focus the first still-visible tab so the user lands on a live terminal.
    if (!this._fleetSelectedKey || !this._fleetFindTab(this._fleetSelectedKey)) {
      const first = this._fleetVisibleTabs()[0];
      if (first) this.selectFleetTab(first.key);
    }
  },

  /** Restore the local session view intact. Fleet terminals are kept alive. */
  hideFleetDashboard() {
    const dash = document.getElementById('fleet-dashboard');
    if (dash) dash.classList.add('hidden');
    const localRoot = document.querySelector('.app');
    if (localRoot) localRoot.style.display = '';
    this._fleetShown = false;
    // The local xterm was sized while display:none was toggling; refit it.
    if (this.fitAddon && this.terminal) {
      try {
        this.fitAddon.fit();
      } catch {
        /* terminal not ready — ignore */
      }
    }
  },

  /** Refresh state from the server, then re-render the visible zones. */
  async refreshFleetState() {
    const next = await this.listFleet();
    if (!next) return;
    this._fleetState = next;
    this.renderFleetDevices();
    this._renderFleetSessions();
    this.renderFleetTabs();
    // Rule 7: a device coming back online (fleet:device-online → here) should
    // auto-reconnect any pinned tile that's still showing its offline overlay.
    this._fleetReconnectOfflineTiles();
  },

  // ─────────────────────────────────────────────────────────────
  // Device list
  // ─────────────────────────────────────────────────────────────

  renderFleetDevices() {
    const host = document.getElementById('fleet-devices');
    if (!host || !this._fleetState) return;
    const devices = this._fleetState.devices || [];
    if (!this._fleetSelectedDeviceId && devices.length) {
      const local = devices.find((d) => d.id === 'local');
      this._fleetSelectedDeviceId = local ? local.id : devices[0].id;
    }
    const empty = document.getElementById('fleet-empty');
    if (empty) empty.classList.toggle('hidden', devices.length > 0);
    host.innerHTML = devices.map((d) => this._fleetDeviceCardHtml(d)).join('');
  },

  _fleetDeviceCardHtml(d) {
    const offline = d.status !== 'online';
    const selected = d.id === this._fleetSelectedDeviceId;
    const caps = d.capabilities || {};
    const capWarn = caps.tmux === false ? `<div class="fleet-cap-error">⚠ 无 tmux · 会话不可持久</div>` : '';
    const name = escapeHtml(d.name || d.hostname || d.id);
    const platform = escapeHtml([d.platform, d.arch].filter(Boolean).join(' '));
    const hostname = escapeHtml(d.hostname || '');
    const count = Number(d.activeSessionCount) || 0;
    const meta = [platform, hostname].filter(Boolean).join(' · ');
    return `<div class="fleet-device-card${offline ? ' offline' : ''}${selected ? ' selected' : ''}" data-device-id="${escapeHtml(d.id)}">
      <div class="fleet-device-head"><span class="dot ${offline ? 'offline' : 'online'}"></span><span class="fleet-device-name">${name}</span></div>
      <div class="fleet-device-meta">${meta}</div>
      <div class="fleet-device-meta">活动会话 ${count}</div>
      ${capWarn}
    </div>`;
  },

  _onFleetDevicesClick(e) {
    const card = e.target.closest('.fleet-device-card');
    if (!card) return;
    const deviceId = card.dataset.deviceId;
    if (!deviceId || deviceId === this._fleetSelectedDeviceId) return;
    this._fleetSelectedDeviceId = deviceId;
    this.renderFleetDevices();
    this._renderFleetSessions();
  },

  // ─────────────────────────────────────────────────────────────
  // Session list (for the selected device)
  // ─────────────────────────────────────────────────────────────

  _renderFleetSessions() {
    const host = document.getElementById('fleet-sessions');
    if (!host || !this._fleetState) return;
    const deviceId = this._fleetSelectedDeviceId;
    const device = (this._fleetState.devices || []).find((d) => d.id === deviceId);
    let sessions = (this._fleetState.sessions || []).filter((s) => s.deviceId === deviceId);
    if (!this._fleetShowHistory) sessions = sessions.filter((s) => s.status !== 'stopped');
    const title = device ? escapeHtml(device.name || device.hostname || device.id) : '设备';
    const toggle = this._fleetShowHistory ? '隐藏历史' : '显示历史';
    const rows =
      sessions.map((s) => this._fleetSessionRowHtml(s)).join('') || `<div class="fleet-session-empty">无会话</div>`;
    host.innerHTML = `<div class="fleet-sessions-head"><span>${title} · 会话</span><button type="button" class="fleet-history-toggle" data-action="toggle-history">${toggle}</button></div>${rows}`;
  },

  _fleetSessionRowHtml(s) {
    const key = `${s.deviceId}:${s.id}`;
    const label = escapeHtml(s.name || s.workingDir || s.id);
    const stopped = s.status === 'stopped';
    const actions = stopped
      ? ''
      : `<button type="button" class="fleet-session-open" data-action="open" data-key="${escapeHtml(key)}">打开</button><button type="button" class="fleet-session-stop" data-action="stop" data-device-id="${escapeHtml(s.deviceId)}" data-session-id="${escapeHtml(s.id)}">停止</button>`;
    return `<div class="fleet-session-row">
      <span class="dot ${escapeHtml(this._fleetStatusDot(s.status))}"></span>
      <span class="fleet-session-mode">${escapeHtml(s.mode)}</span>
      <span class="fleet-session-label" title="${escapeHtml(s.workingDir || '')}">${label}</span>
      ${actions}
    </div>`;
  },

  async _onFleetSessionsClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'toggle-history') {
      this._fleetShowHistory = !this._fleetShowHistory;
      this._renderFleetSessions();
    } else if (action === 'open') {
      const key = btn.dataset.key;
      if (!key) return;
      this._fleetHiddenTabKeys.delete(key);
      this.selectFleetTab(key);
    } else if (action === 'stop') {
      const { deviceId, sessionId } = btn.dataset;
      if (!deviceId || !sessionId) return;
      btn.disabled = true;
      await this.fleetStopSession(deviceId, sessionId);
      await this.refreshFleetState();
    }
  },

  // ─────────────────────────────────────────────────────────────
  // Global tab strip
  // ─────────────────────────────────────────────────────────────

  renderFleetTabs() {
    const host = document.getElementById('fleet-tabs');
    if (!host || !this._fleetState) return;
    host.innerHTML = this._fleetVisibleTabs()
      .map((t) => this._fleetTabHtml(t))
      .join('');
  },

  _fleetVisibleTabs() {
    const tabs = (this._fleetState && this._fleetState.sessionTabs) || [];
    return tabs.filter((t) => !this._fleetHiddenTabKeys.has(t.key));
  },

  _fleetFindTab(key) {
    const tabs = (this._fleetState && this._fleetState.sessionTabs) || [];
    return tabs.find((t) => t.key === key) || null;
  },

  _fleetStatusDot(status) {
    if (status === 'busy') return 'busy';
    if (status === 'error') return 'error';
    return 'idle';
  },

  _fleetTabHtml(t) {
    const active = t.key === this._fleetSelectedKey;
    const pinned = Array.isArray(this._fleetPinned) && this._fleetPinned.indexOf(t.key) !== -1;
    return `<div class="fleet-tab${active ? ' active' : ''}${pinned ? ' pinned' : ''}" data-key="${escapeHtml(t.key)}" title="${escapeHtml(t.title)}">
      <span class="dot ${escapeHtml(this._fleetStatusDot(t.status))}"></span>
      <span class="fleet-tab-title">${escapeHtml(t.title)}</span>
      <span class="fleet-tab-mode">${escapeHtml(t.mode)}</span>
      <button type="button" class="fleet-tab-pin${pinned ? ' active' : ''}" data-action="pin-tab" data-key="${escapeHtml(t.key)}" aria-label="${pinned ? '已钉选到分屏' : '钉选到分屏'}" title="${pinned ? '已钉选到分屏' : '钉选到分屏'}">📌</button>
      <button type="button" class="fleet-tab-close" data-action="close-tab" data-key="${escapeHtml(t.key)}" aria-label="关闭标签">×</button>
    </div>`;
  },

  _onFleetTabsClick(e) {
    const pinBtn = e.target.closest('[data-action="pin-tab"]');
    if (pinBtn) {
      const key = pinBtn.dataset.key;
      if (key) this.pinFleetTab(key);
      return;
    }
    const closeBtn = e.target.closest('[data-action="close-tab"]');
    if (closeBtn) {
      const key = closeBtn.dataset.key;
      if (!key) return;
      // Local-only close: drop from the visible set and tear down this browser's
      // terminal/WS. The session KEEPS RUNNING on the device (never stopped).
      this._fleetHiddenTabKeys.add(key);
      // If this tab is pinned into a grid slot, free the slot too — otherwise
      // _fleetPinned would keep pointing at a key whose instance just died.
      const pinnedIdx = Array.isArray(this._fleetPinned) ? this._fleetPinned.indexOf(key) : -1;
      if (pinnedIdx !== -1) this._fleetPinned[pinnedIdx] = null;
      this.closeFleetTerminal(key);
      if (this._fleetSelectedKey === key) {
        this._fleetSelectedKey = null;
        const next = this._fleetVisibleTabs()[0];
        if (next) this.selectFleetTab(next.key);
      }
      this.renderFleetTabs();
      if (pinnedIdx !== -1) this._fleetRenderTiles();
      return;
    }
    const tab = e.target.closest('.fleet-tab');
    if (!tab || !tab.dataset.key) return;
    this.selectFleetTab(tab.dataset.key);
  },

  selectFleetTab(key) {
    this._fleetSelectedKey = key;
    const tab = this._fleetFindTab(key);
    if (tab) this._fleetSelectedDeviceId = tab.deviceId;

    if (this._fleetLayout && this._fleetLayout > 1) {
      // Task 14: the grid has no #fleet-term-main, so every pre-existing
      // caller of selectFleetTab (tab click, session list "打开", new-session
      // auto-select) needs a grid-aware meaning for "select" instead of
      // silently no-op'ing against a missing container. Focus the tile if
      // already pinned; otherwise pin into the first empty/oldest slot.
      this.renderFleetTabs();
      this.renderFleetDevices();
      this._renderFleetSessions();
      const idx = (this._fleetPinned || []).indexOf(key);
      if (idx !== -1) {
        this._fleetFocusTile(idx);
        this._fleetTouch(key);
      } else {
        this.pinFleetTab(key);
      }
      return;
    }

    // Layout 1: unchanged Task 13 single-tile behavior. _fleetPinned[0] is
    // kept in sync purely as bookkeeping (grow-from-1 layout switches and the
    // ≤6-instance eviction both read _fleetPinned) — it does not alter what
    // gets rendered here.
    this._fleetPinned = [key];
    this.renderFleetTabs();
    this.renderFleetDevices();
    this._renderFleetSessions();
    this.openFleetTerminal(key, document.getElementById('fleet-term-main'));
    this._fleetTouch(key);
    this._fleetEvictIfNeeded();
  },

  // ─────────────────────────────────────────────────────────────
  // Terminal
  // ─────────────────────────────────────────────────────────────

  /**
   * Open (or re-attach) the remote terminal for `key` inside `containerEl`.
   * Reuses an existing instance by relocating its DOM. New instances load a
   * replay buffer, then bind a dedicated WS whose input closure captures THIS
   * socket only (no cross-device keystroke leakage).
   */
  async openFleetTerminal(key, containerEl) {
    if (!key || !containerEl) return;

    const existing = this._fleetTerms.get(key);
    if (existing) {
      // A closed/closing WebSocket can never be reused — re-attaching one would
      // give a live-looking tile with a dead input/output pipe (this is the
      // stale-dead-rec reuse path: an offline tile the reconnect sweep hasn't
      // reached yet, or one whose device dropped). Tear the dead rec down and
      // fall through to build a fresh terminal + WS. CONNECTING (0)/OPEN (1) are
      // healthy and re-attach normally.
      const wsState = existing.ws ? existing.ws.readyState : 3;
      if (wsState !== 0 && wsState !== 1) {
        this.closeFleetTerminal(key);
      } else {
        return this._fleetReattachTerminal(existing, key, containerEl);
      }
    }
    // Fresh instance (no existing rec, or the dead one was just torn down above).
    {
      const { deviceId, sessionId } = this._fleetSplitKey(key);
      if (!deviceId || !sessionId) return;
      await this._fleetCreateTerminal(key, deviceId, sessionId, containerEl);
    }
  },

  /** Re-attach an existing live terminal `rec` into `containerEl` (DOM relocate,
   *  ResizeObserver rebind, offline-overlay reapply). Split out of openFleetTerminal
   *  so the dead-WS reopen path can cleanly fall through to fresh creation. */
  _fleetReattachTerminal(existing, key, containerEl) {
    // Re-attach by checking the ACTUAL DOM parent, not the cached `el`: a
    // sibling tab's open() may have cleared this container (innerHTML=''),
    // detaching this alive-but-hidden terminal. Without this check a
    // switch-back into the same tile would leave it blank.
    const node = existing.term.element;
    if (node && node.parentElement !== containerEl) {
      containerEl.innerHTML = '';
      containerEl.appendChild(node);
    }
    // Task 14: grid layout switches rebuild the tile DOM wholesale, so a
    // surviving pinned key's ResizeObserver would otherwise keep watching
    // the OLD (now detached) container forever. Re-bind it to the new one
    // whenever the container actually changed. No-op for Task 13's
    // single-tile path, where containerEl is always the same persistent
    // #fleet-term-main node.
    if (existing.el !== containerEl) {
      try {
        if (existing.resizeObserver) existing.resizeObserver.disconnect();
      } catch {
        /* already disconnected */
      }
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => {
          try {
            existing.fit.fit();
          } catch {
            /* container hidden */
          }
          this._fleetSendResize(key);
        });
        ro.observe(containerEl);
        existing.resizeObserver = ro;
      }
    }
    existing.el = containerEl;
    try {
      existing.fit.fit();
    } catch {
      /* not measurable yet */
    }
    this._fleetSendResize(key);
    // Reattaching moves only the terminal's own DOM node — any offline
    // overlay lived in the OLD container and was left behind. Reapply it so
    // a still-offline tile doesn't look silently "recovered" after a
    // layout switch or tab re-select.
    if (existing.offline) this._fleetMarkTileOffline(key);
  },

  /**
   * Build a brand-new terminal + dedicated WS for `key` inside `containerEl`.
   * Loads a replay buffer, then binds a dedicated WS whose input closure
   * captures THIS socket only (no cross-device keystroke leakage).
   */
  async _fleetCreateTerminal(key, deviceId, sessionId, containerEl) {
    containerEl.innerHTML = '';
    const term = new Terminal({
      scrollback: 5000,
      allowProposedApi: true,
      fontFamily: '"Fira Code", "Cascadia Code", "JetBrains Mono", "SF Mono", Monaco, monospace',
      fontSize: 13,
      cursorBlink: false,
      allowTransparency: true,
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(containerEl);
    this._fleetApplyRenderer(term);
    try {
      fit.fit();
    } catch {
      /* not measurable yet */
    }

    const rec = {
      term,
      fit,
      ws: null,
      el: containerEl,
      seq: 0,
      cid: `fleet-${Math.random().toString(36).slice(2, 10)}`,
      resizeObserver: null,
      offline: false,
      offlineEl: null,
      // Set by closeFleetTerminal before it calls ws.close() so this rec's own
      // onclose handler can tell an intentional teardown (no overlay) from an
      // involuntary drop (device offline / cap / generic → recoverable overlay).
      intentionalClose: false,
      // The overlay message to (re)paint while offline; kept on the rec so the
      // re-attach path reapplies the SAME reason after a layout switch/tab select.
      offlineMessage: null,
    };
    this._fleetTerms.set(key, rec);

    // Replay buffer (best effort — remote may not support capture).
    try {
      const res = await this.fleetTerminalBuffer(deviceId, sessionId);
      if (res && res.buffer) term.write(res.buffer);
    } catch {
      /* buffer optional */
    }

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws/fleet/devices/${encodeURIComponent(deviceId)}/sessions/${encodeURIComponent(sessionId)}/terminal`;
    const ws = new WebSocket(url);
    rec.ws = ws;
    ws.onopen = () => this._fleetSendResize(key);
    ws.onmessage = (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.t === 'o') term.write(m.d);
      else if (m.t === 'c') term.clear();
      else if (m.t === 'r') this._fleetRefreshBuffer(key);
      // m.t === 'ia' (input ack): no local pending queue to reconcile here.
    };
    ws.onclose = (ev) => {
      // An intentional teardown (closeFleetTerminal) sets this flag on THIS rec
      // before closing — leave no overlay. Any OTHER close (device offline 4009,
      // per-IP cap 4008, network drop / server restart with no code) is an
      // involuntary disconnect: paint a recoverable overlay and mark rec.offline
      // so fleet:device-online → _fleetReconnectOfflineTiles reopens it. Messages
      // are static string literals (no interpolation) to preserve XSS discipline.
      if (rec.intentionalClose) return;
      const message = ev && ev.code === 4008 ? '连接数已达上限' : '连接已断开';
      this._fleetMarkTileOffline(key, message);
    };
    ws.onerror = () => {
      /* surfaced via onclose */
    };

    // Input handler bound to THIS socket via closure — cannot cross devices.
    term.onData((d) => {
      if (ws.readyState !== 1) return;
      rec.seq += 1;
      ws.send(JSON.stringify({ t: 'i', d, seq: rec.seq, cid: rec.cid }));
    });

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => {
        try {
          fit.fit();
        } catch {
          /* container hidden */
        }
        this._fleetSendResize(key);
      });
      ro.observe(containerEl);
      rec.resizeObserver = ro;
    }
  },

  /**
   * Grid tiles render on canvas (the xterm default). Only the single-tile
   * layout (data-layout="1") optionally upgrades to WebGL, and only on desktop
   * where the addon has been loaded (spec §6.2 / 必查项 3).
   */
  _fleetApplyRenderer(term) {
    const area = document.getElementById('fleet-term-area');
    const single = !area || area.getAttribute('data-layout') === '1';
    if (!single) return;
    if (
      typeof MobileDetection !== 'undefined' &&
      MobileDetection.getDeviceType &&
      MobileDetection.getDeviceType() !== 'desktop'
    ) {
      return;
    }
    if (typeof WebglAddon === 'undefined') return;
    try {
      const addon = new WebglAddon.WebglAddon();
      if (typeof addon.onContextLoss === 'function') {
        addon.onContextLoss(() => {
          try {
            addon.dispose();
          } catch {
            /* already gone */
          }
        });
      }
      term.loadAddon(addon);
    } catch {
      /* WebGL unavailable — canvas/DOM renderer is fine */
    }
  },

  _fleetSplitKey(key) {
    const tab = this._fleetFindTab(key);
    if (tab) return { deviceId: tab.deviceId, sessionId: tab.sessionId };
    // Fallback: split on the FIRST colon only (sessionId may contain ':').
    const parts = key.split(/:(.+)/);
    return { deviceId: parts[0], sessionId: parts[1] };
  },

  _fleetSendResize(key) {
    const rec = this._fleetTerms.get(key);
    if (!rec || !rec.ws || rec.ws.readyState !== 1) return;
    const cols = rec.term.cols;
    const rows = rec.term.rows;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return;
    rec.ws.send(JSON.stringify({ t: 'z', c: cols, r: rows, v: 'desktop' }));
  },

  async _fleetRefreshBuffer(key) {
    const rec = this._fleetTerms.get(key);
    if (!rec) return;
    const { deviceId, sessionId } = this._fleetSplitKey(key);
    if (!deviceId || !sessionId) return;
    try {
      const res = await this.fleetTerminalBuffer(deviceId, sessionId);
      rec.term.reset();
      if (res && res.buffer) rec.term.write(res.buffer);
    } catch {
      /* keep whatever is on screen */
    }
  },

  _fleetMarkTileOffline(key, message) {
    const rec = this._fleetTerms.get(key);
    if (!rec) return;
    // Task 14: persists across reattach (layout switches rebuild tile DOM),
    // where openFleetTerminal's re-attach path re-applies the overlay if this
    // flag is still set. Set unconditionally, even if the overlay node
    // already exists, so a fresh rec (or one whose container just changed)
    // stays marked.
    rec.offline = true;
    // Remember the reason so the re-attach path (which calls this with no
    // message) repaints the same text. `message` is always a static string
    // literal from the caller — never interpolated user/remote data — so
    // textContent below stays XSS-safe.
    if (typeof message === 'string') rec.offlineMessage = message;
    const overlayText = rec.offlineMessage || '设备已离线';
    // rec.el can be STALE: in layout 1 every background tab's rec.el aliases
    // the SAME #fleet-term-main container the currently-visible tab now owns
    // (selectFleetTab never closes the previous tab's rec — see task-14
    // report). Only paint the overlay when this terminal's own node is
    // actually the thing living in rec.el right now; otherwise we'd stamp
    // "offline" onto whatever OTHER key's terminal currently occupies that
    // container. openFleetTerminal's re-attach path reapplies the overlay
    // once this terminal is handed its own container back.
    const node = rec.term && rec.term.element;
    if (!rec.el || !node || node.parentElement !== rec.el) return;
    if (rec.el.querySelector('.tile-offline')) return;
    const overlay = document.createElement('div');
    overlay.className = 'tile-offline';
    overlay.textContent = overlayText;
    rec.el.appendChild(overlay);
    rec.offlineEl = overlay;
  },

  closeFleetTerminal(key) {
    const rec = this._fleetTerms.get(key);
    if (!rec) return;
    // Mark BEFORE closing so this rec's onclose handler treats the close as
    // intentional and skips the recoverable offline overlay. The captured `rec`
    // in that closure sees this flag even after we delete the key below (a reopen
    // for the same key would install a NEW rec, so the stale onclose can't stamp
    // the fresh tile offline).
    rec.intentionalClose = true;
    try {
      if (rec.resizeObserver) rec.resizeObserver.disconnect();
    } catch {
      /* ignore */
    }
    try {
      if (rec.ws) rec.ws.close();
    } catch {
      /* ignore */
    }
    try {
      // xterm's own dispose() already detaches term.element from whatever
      // parent it currently lives in (it registers an internal disposable
      // that does `this.element?.parentNode?.removeChild(this.element)`) —
      // that removal is already surgical, scoped to this terminal's own
      // node. What is NOT safe is touching rec.el itself: in layout 1 every
      // background tab's rec.el aliases the SAME #fleet-term-main container
      // the currently-visible tab now owns (selectFleetTab opens every tab
      // into that one container and never closes the previous tab's rec).
      // Blanket-clearing rec.el here — reachable via _fleetEvictIfNeeded
      // once a 7th session is opened, or via the tab-close ("×") button on
      // any background tab — would wipe out whatever OTHER key's terminal
      // is now living in that container, blanking the visible tile.
      rec.term.dispose();
    } catch {
      /* ignore */
    }
    // The offline overlay (if any) is a plain DOM node this rec created for
    // itself — xterm's dispose() doesn't know about it. Remove it via its
    // OWN current parent reference, never via rec.el, for the same
    // stale-container reason as above.
    if (rec.offlineEl && rec.offlineEl.parentElement) {
      rec.offlineEl.parentElement.removeChild(rec.offlineEl);
    }
    this._fleetTerms.delete(key);
    if (this._fleetSelectedKey === key) this._fleetSelectedKey = null;
  },

  // ─────────────────────────────────────────────────────────────
  // Split-grid layout (Task 14)
  // ─────────────────────────────────────────────────────────────

  /**
   * Switch the grid to 1 / 2 / 2x2 tiles. Surviving pinned keys carry forward
   * into the EARLIEST slots of the new array (spec: shrink keeps earliest
   * slots); anything that falls off the end is torn down via
   * closeFleetTerminal. The tile DOM is rebuilt from scratch, then every
   * surviving/new slot is (re)opened — openFleetTerminal's re-attach path
   * (adapted above to re-bind the ResizeObserver) makes that cheap for keys
   * that were already alive.
   */
  setFleetLayout(n) {
    n = Number(n);
    if (n !== 1 && n !== 2 && n !== 4) return;
    const area = document.getElementById('fleet-term-area');
    if (!area) return;
    if (n === this._fleetLayout) {
      this._updateLayoutToolbar();
      return;
    }

    const carried = this._fleetLayout === 1 ? [this._fleetSelectedKey || null] : (this._fleetPinned || []).slice();
    const nextPinned = new Array(n).fill(null);
    for (let i = 0; i < n; i++) nextPinned[i] = carried[i] || null;
    // Shrink: close whatever falls off the end of the carried array.
    for (let i = n; i < carried.length; i++) {
      const key = carried[i];
      if (key) this.closeFleetTerminal(key);
    }

    this._fleetLayout = n;
    this._fleetPinned = nextPinned;
    this._fleetFocusedTileIndex = 0;
    area.setAttribute('data-layout', String(n));

    if (n === 1) {
      area.innerHTML = `<div class="fleet-tile" id="fleet-term-main"></div>`;
      this._updateLayoutToolbar();
      const key = nextPinned[0];
      // Always re-render the tab strip: slots that fell off the end above
      // were just closeFleetTerminal'd, so their .pinned highlight must
      // clear even when the surviving slot 0 is also empty.
      this._fleetSelectedKey = key || null;
      this.renderFleetTabs();
      if (key) this._fleetOpenTile(key, document.getElementById('fleet-term-main'));
      return;
    }

    area.innerHTML = nextPinned.map((_, i) => this._fleetTileShellHtml(i)).join('');
    this._updateLayoutToolbar();
    this.renderFleetTabs();
    this._fleetRenderTiles();
  },

  _updateLayoutToolbar() {
    const toolbar = document.getElementById('fleet-layout-toolbar');
    if (!toolbar) return;
    toolbar.querySelectorAll('[data-layout-btn]').forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.layoutBtn) === this._fleetLayout);
    });
  },

  _fleetTileShellHtml(i) {
    return `<div class="fleet-tile fleet-tile-grid" id="fleet-tile-${i}" data-tile-index="${i}">
      <div class="fleet-tile-head"></div>
      <div class="fleet-tile-body" id="fleet-tile-${i}-body"></div>
    </div>`;
  },

  /** (Re)populate every grid tile's header + terminal from _fleetPinned. No-op in layout 1. */
  _fleetRenderTiles() {
    if (this._fleetLayout === 1 || !Array.isArray(this._fleetPinned)) return;
    for (let i = 0; i < this._fleetPinned.length; i++) {
      const key = this._fleetPinned[i];
      const tileEl = document.getElementById(`fleet-tile-${i}`);
      const bodyEl = document.getElementById(`fleet-tile-${i}-body`);
      if (!tileEl || !bodyEl) continue;
      const headEl = tileEl.querySelector('.fleet-tile-head');
      tileEl.classList.toggle('focused', i === this._fleetFocusedTileIndex);
      if (!key) {
        if (headEl)
          headEl.innerHTML = `<span class="fleet-tile-title fleet-tile-empty">空位 · 点击标签页的 📌 钉选到此</span>`;
        bodyEl.innerHTML = '';
        continue;
      }
      const tab = this._fleetFindTab(key);
      const title = escapeHtml(tab ? tab.title : key);
      if (headEl) {
        headEl.innerHTML = `<span class="fleet-tile-title">${title}</span><button type="button" class="fleet-tile-close" data-action="unpin-tile" data-index="${i}" aria-label="取消钉选">×</button>`;
      }
      this._fleetOpenTile(key, bodyEl);
    }
  },

  /** openFleetTerminal + LRU bookkeeping + eviction, for every Task 14 call site that opens a tile. */
  _fleetOpenTile(key, containerEl) {
    this.openFleetTerminal(key, containerEl);
    this._fleetTouch(key);
    this._fleetEvictIfNeeded();
  },

  /**
   * Pin `key` into the first empty grid slot (or replace the least-recently-
   * used pinned slot if full). If `key` is already pinned somewhere, this is
   * the same-session-double-pin guard (spec rule 4): no second instance is
   * created — the existing tile is focused and the user gets a hint instead.
   */
  pinFleetTab(key) {
    if (!key || !this._fleetState) return;
    if (!Array.isArray(this._fleetPinned) || this._fleetPinned.length !== this._fleetLayout) {
      this._fleetPinned = new Array(this._fleetLayout).fill(null);
    }
    const existingIdx = this._fleetPinned.indexOf(key);
    if (existingIdx !== -1) {
      this.showToast?.('已在分屏中', 'info');
      this._fleetFocusTile(existingIdx);
      this._fleetTouch(key);
      return;
    }
    if (this._fleetLayout === 1) {
      // Single-tile layout: "pin" and "select" are the same action.
      this.selectFleetTab(key);
      return;
    }
    let slot = this._fleetPinned.indexOf(null);
    if (slot === -1) {
      slot = this._fleetOldestPinnedSlot();
      const evictedKey = this._fleetPinned[slot];
      if (evictedKey) this.closeFleetTerminal(evictedKey);
    }
    this._fleetPinned[slot] = key;
    this.renderFleetTabs();
    this._fleetRenderTiles();
    this._fleetFocusTile(slot);
  },

  /** Clear grid slot `index`, tearing down its terminal/WS if occupied. */
  unpinFleetTile(index) {
    if (!Array.isArray(this._fleetPinned) || index < 0 || index >= this._fleetPinned.length) return;
    const key = this._fleetPinned[index];
    this._fleetPinned[index] = null;
    if (key) {
      this.closeFleetTerminal(key);
      if (this._fleetLru) this._fleetLru.delete(key);
    }
    if (this._fleetLayout === 1) {
      const area = document.getElementById('fleet-term-area');
      if (area) area.innerHTML = `<div class="fleet-tile" id="fleet-term-main"></div>`;
      this.renderFleetTabs();
      return;
    }
    this.renderFleetTabs();
    this._fleetRenderTiles();
  },

  _fleetOldestPinnedSlot() {
    let slot = 0;
    let oldest = Infinity;
    for (let i = 0; i < this._fleetPinned.length; i++) {
      const k = this._fleetPinned[i];
      if (!k) return i;
      const t = (this._fleetLru && this._fleetLru.get(k)) || 0;
      if (t < oldest) {
        oldest = t;
        slot = i;
      }
    }
    return slot;
  },

  /** Visual-only tile focus (rule 3) — keyboard focus stays with xterm itself. */
  _fleetFocusTile(index) {
    this._fleetFocusedTileIndex = index;
    const area = document.getElementById('fleet-term-area');
    if (!area) return;
    area.querySelectorAll('.fleet-tile').forEach((el) => el.classList.remove('focused'));
    const tile = document.getElementById(`fleet-tile-${index}`);
    if (tile) tile.classList.add('focused');
  },

  _fleetTouch(key) {
    if (!this._fleetLru) this._fleetLru = new Map();
    this._fleetLru.set(key, Date.now());
  },

  /**
   * Cap total live remote-terminal WS connections at 6 (spec: mirrors the
   * central controller's own ≤6 concurrency ceiling). Every currently pinned
   * key (any grid slot) is exempt; among the rest, close the
   * least-recently-used first. Runs after every _fleetOpenTile so growth past
   * the cap — mainly from background layout-1 tab history — is corrected
   * immediately.
   */
  _fleetEvictIfNeeded() {
    if (!this._fleetTerms) return;
    const pinnedSet = new Set((this._fleetPinned || []).filter(Boolean));
    while (this._fleetTerms.size > 6) {
      let oldestKey = null;
      let oldestTime = Infinity;
      for (const key of this._fleetTerms.keys()) {
        if (pinnedSet.has(key)) continue;
        const t = (this._fleetLru && this._fleetLru.get(key)) || 0;
        if (t < oldestTime) {
          oldestTime = t;
          oldestKey = key;
        }
      }
      if (!oldestKey) break; // everything left is pinned — can't evict further
      this.closeFleetTerminal(oldestKey);
      if (this._fleetLru) this._fleetLru.delete(oldestKey);
    }
  },

  _onFleetTermAreaClick(e) {
    const unpinBtn = e.target.closest('[data-action="unpin-tile"]');
    if (unpinBtn) {
      const idx = Number(unpinBtn.dataset.index);
      if (Number.isInteger(idx)) this.unpinFleetTile(idx);
      return;
    }
    const tile = e.target.closest('.fleet-tile[data-tile-index]');
    if (!tile) return;
    const idx = Number(tile.dataset.tileIndex);
    if (!Number.isInteger(idx)) return;
    this._fleetFocusTile(idx);
    const key = this._fleetPinned[idx];
    if (key) this._fleetTouch(key);
  },

  /**
   * Rule 7: a device that just came back online (SSE fleet:device-online →
   * refreshFleetState → here) may still have pinned tiles showing the
   * offline overlay from their old (permanently-closed) WS. Tear those down
   * and reopen fresh — a closed WebSocket cannot be reused, so "reconnect"
   * means a full closeFleetTerminal + openFleetTerminal cycle.
   */
  _fleetReconnectOfflineTiles() {
    if (!this._fleetState || !Array.isArray(this._fleetPinned)) return;
    const devicesById = new Map((this._fleetState.devices || []).map((d) => [d.id, d]));
    this._fleetPinned.forEach((key, index) => {
      if (!key) return;
      const rec = this._fleetTerms.get(key);
      if (!rec || !rec.offline) return;
      const { deviceId } = this._fleetSplitKey(key);
      const device = devicesById.get(deviceId);
      if (!device || device.status !== 'online') return;
      this.closeFleetTerminal(key);
      if (this._fleetLayout === 1) {
        this._fleetSelectedKey = key;
        this.renderFleetTabs();
        this._fleetOpenTile(key, document.getElementById('fleet-term-main'));
      } else {
        const bodyEl = document.getElementById(`fleet-tile-${index}-body`);
        if (bodyEl) this._fleetOpenTile(key, bodyEl);
      }
    });
  },

  // ─────────────────────────────────────────────────────────────
  // Pairing drawer
  // ─────────────────────────────────────────────────────────────

  async openFleetPairingDrawer() {
    const drawer = document.getElementById('fleet-pair-drawer');
    if (!drawer) return;
    drawer.classList.remove('hidden');
    drawer.innerHTML = `<div class="fleet-drawer-body">生成配对码中…</div>`;
    const data = await this.fleetCreatePairingCode();
    if (!data) {
      drawer.innerHTML = `<div class="fleet-drawer-body"><div class="fleet-drawer-head"><span>添加设备</span><button type="button" data-action="close-drawer" aria-label="关闭">×</button></div><div class="fleet-form-error">生成配对码失败</div></div>`;
      return;
    }
    const code = escapeHtml(String(data.code || ''));
    const joinCommand = escapeHtml(String(data.joinCommand || ''));
    const expiresAt = Number(data.expiresAt) || 0;
    drawer.innerHTML = `<div class="fleet-drawer-body">
      <div class="fleet-drawer-head"><span>添加设备</span><button type="button" data-action="close-drawer" aria-label="关闭">×</button></div>
      <div class="fleet-pair-code" data-action="copy-code">${code}</div>
      <div class="fleet-pair-expiry" id="fleet-pair-expiry"></div>
      <label class="fleet-form-label">在目标设备执行:</label>
      <div class="fleet-pair-cmd"><code>${joinCommand}</code><button type="button" data-action="copy-join">复制</button></div>
    </div>`;
    this._fleetStartPairCountdown(expiresAt);
  },

  _fleetStartPairCountdown(expiresAt) {
    if (this._fleetPairTimer) {
      clearInterval(this._fleetPairTimer);
      this._fleetPairTimer = null;
    }
    const tick = () => {
      const el = document.getElementById('fleet-pair-expiry');
      if (!el) {
        if (this._fleetPairTimer) clearInterval(this._fleetPairTimer);
        this._fleetPairTimer = null;
        return;
      }
      const remain = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
      if (remain <= 0) {
        el.textContent = '配对码已过期';
        if (this._fleetPairTimer) clearInterval(this._fleetPairTimer);
        this._fleetPairTimer = null;
        return;
      }
      const mm = String(Math.floor(remain / 60)).padStart(2, '0');
      const ss = String(remain % 60).padStart(2, '0');
      el.textContent = `有效期剩余 ${mm}:${ss}`;
    };
    tick();
    this._fleetPairTimer = setInterval(tick, 1000);
  },

  _onFleetPairDrawerClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'close-drawer') {
      const drawer = document.getElementById('fleet-pair-drawer');
      if (drawer) drawer.classList.add('hidden');
      if (this._fleetPairTimer) {
        clearInterval(this._fleetPairTimer);
        this._fleetPairTimer = null;
      }
    } else if (action === 'copy-join' || action === 'copy-code') {
      const drawer = document.getElementById('fleet-pair-drawer');
      const sel = action === 'copy-join' ? '.fleet-pair-cmd code' : '.fleet-pair-code';
      const node = drawer && drawer.querySelector(sel);
      // textContent is the decoded (un-escaped) original — safe to copy verbatim.
      const text = node ? node.textContent : '';
      if (text && navigator.clipboard) {
        navigator.clipboard.writeText(text).catch(() => {
          /* clipboard blocked — no-op */
        });
      }
      if (btn.dataset.action === 'copy-join' || btn.dataset.action === 'copy-code') {
        const prev = btn.textContent;
        if (btn.tagName === 'BUTTON') {
          btn.textContent = '已复制';
          setTimeout(() => {
            btn.textContent = prev;
          }, 1200);
        }
      }
    }
  },

  // ─────────────────────────────────────────────────────────────
  // New-session form (dynamic drawer)
  // ─────────────────────────────────────────────────────────────

  openFleetNewSessionForm() {
    const dash = document.getElementById('fleet-dashboard');
    if (!dash || !this._fleetState) return;
    let drawer = document.getElementById('fleet-session-drawer');
    if (!drawer) {
      drawer = document.createElement('div');
      drawer.id = 'fleet-session-drawer';
      drawer.className = 'fleet-drawer';
      dash.appendChild(drawer);
      drawer.addEventListener('click', (e) => this._onFleetSessionDrawerClick(e));
      drawer.addEventListener('submit', (e) => this._onFleetSessionSubmit(e));
    }
    const devices = this._fleetState.devices || [];
    const options = devices
      .map((d) => {
        const off = d.status !== 'online';
        const selected = !off && d.id === this._fleetSelectedDeviceId ? ' selected' : '';
        const label = escapeHtml((d.name || d.hostname || d.id) + (off ? ' (离线)' : ''));
        return `<option value="${escapeHtml(d.id)}"${off ? ' disabled' : ''}${selected}>${label}</option>`;
      })
      .join('');
    const modes = ['claude', 'codex', 'shell', 'gemini', 'opencode'];
    const modeBtns = modes
      .map(
        (m) =>
          `<button type="button" class="fleet-mode-btn${m === 'shell' ? ' active' : ''}" data-mode="${m}">${m}</button>`
      )
      .join('');
    drawer.classList.remove('hidden');
    drawer.innerHTML = `<form class="fleet-drawer-body" id="fleet-session-form">
      <div class="fleet-drawer-head"><span>新建会话</span><button type="button" data-action="close-session-drawer" aria-label="关闭">×</button></div>
      <label class="fleet-form-label">设备</label>
      <select class="fleet-form-select" name="deviceId">${options}</select>
      <label class="fleet-form-label">工作目录</label>
      <input class="fleet-form-input" name="workingDir" type="text" placeholder="/absolute/path" required autocomplete="off" spellcheck="false" />
      <label class="fleet-form-label">模式</label>
      <div class="fleet-mode-seg" data-mode-value="shell">${modeBtns}</div>
      <div class="fleet-form-error" id="fleet-session-error"></div>
      <div class="fleet-form-actions"><button type="submit" class="fleet-form-submit">创建</button></div>
    </form>`;
  },

  _onFleetSessionDrawerClick(e) {
    const closeBtn = e.target.closest('[data-action="close-session-drawer"]');
    if (closeBtn) {
      const drawer = document.getElementById('fleet-session-drawer');
      if (drawer) drawer.classList.add('hidden');
      return;
    }
    const modeBtn = e.target.closest('.fleet-mode-btn');
    if (modeBtn) {
      const seg = modeBtn.closest('.fleet-mode-seg');
      if (!seg) return;
      seg.querySelectorAll('.fleet-mode-btn').forEach((b) => b.classList.remove('active'));
      modeBtn.classList.add('active');
      seg.setAttribute('data-mode-value', modeBtn.dataset.mode || 'shell');
    }
  },

  async _onFleetSessionSubmit(e) {
    e.preventDefault();
    const form = e.target;
    if (!form || form.id !== 'fleet-session-form') return;
    const deviceId = form.deviceId.value;
    const workingDir = form.workingDir.value.trim();
    const seg = form.querySelector('.fleet-mode-seg');
    const mode = (seg && seg.getAttribute('data-mode-value')) || 'shell';
    const errEl = form.querySelector('#fleet-session-error');
    if (!deviceId) {
      if (errEl) errEl.textContent = '请选择在线设备';
      return;
    }
    if (!workingDir) {
      if (errEl) errEl.textContent = '工作目录必填';
      return;
    }
    if (errEl) errEl.textContent = '';
    const submit = form.querySelector('.fleet-form-submit');
    if (submit) submit.disabled = true;
    const created = await this.fleetCreateSession(deviceId, { workingDir, mode });
    if (submit) submit.disabled = false;
    if (!created) {
      if (errEl) errEl.textContent = '创建失败(设备离线或参数无效)';
      return;
    }
    const drawer = document.getElementById('fleet-session-drawer');
    if (drawer) drawer.classList.add('hidden');
    await this.refreshFleetState();
    const newId = created.id || (created.session && created.session.id);
    if (newId) {
      const key = `${deviceId}:${newId}`;
      this._fleetHiddenTabKeys.delete(key);
      this.selectFleetTab(key);
    }
  },
});
