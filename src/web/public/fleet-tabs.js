/**
 * @fileoverview Fleet remote sessions as first-class native tabs (Rev 3 融入式).
 *
 * Rev 2 shipped a parallel `#fleet-dashboard` page that hid the whole `.app`;
 * the user rejected it ("原仓库 UI 基本没了"). Rev 3 deletes that parallel UI.
 * Remote fleet sessions now live IN the native session tab strip, mixed with
 * local tabs, and render through the EXISTING terminal machinery — this module
 * only maintains a small remote-tab registry and PARAMETERIZES the few data
 * sources (terminal WS URL, buffer URL, reliable-input HTTP fallback URL) so a
 * remote tab hits the fleet endpoints instead of the local `/api/sessions/*`
 * ones. There is no second rendering pipeline.
 *
 * Registry:
 *   `this.fleetTabs` — Map<key, FleetSessionTab+{online,adopted}>, key = `${deviceId}:${sessionId}`.
 *   Populated by `refreshFleetState()` from `GET /api/fleet` (`sessionTabs`),
 *   EXCLUDING the central self device (`deviceId === 'local'`; its sessions are
 *   already native local tabs) and user-hidden keys (`this._fleetHidden`).
 *   `adopted` is cross-referenced from `state.sessions` (FleetSessionSummary
 *   carries it; FleetSessionTab does not) by the shared `key` — drives the 🔗
 *   marker in `_fleetTabHtml` (Rev5 §13.3, Task 29).
 *   Driven by SSE `fleet:device-online` / `fleet:device-offline` /
 *   `fleet:sessions-updated` (all mapped to `refreshFleetState` in app.js).
 *
 * Local red line: `this.sessions` (the local model) is never touched. A key is
 * "fleet" iff it is present in `this.fleetTabs` (`isFleetKey`), so for every
 * local session id these helpers are pure no-ops and local behavior is
 * byte-identical. Selecting a remote tab flows through the SAME `selectSession`;
 * because `this.sessions.get(key)` is `undefined` for a fleet key, all
 * Claude-specific per-session panels (respawn / ralph / project insights /
 * subagents / session-options gear) find nothing and stay hidden — satisfying
 * "remote tabs disable Claude-specific panels" without per-panel gating code.
 *
 * First version scope (spec §6.1 / §11): view terminal, type input, close tab
 * (local visibility only), and an explicit `stopFleetSession()` (wired into the
 * device panel in Task 19).
 *
 * Split-grid (Task 20, spec §6.3): the second half of this module re-implements
 * the deleted Rev 2 grid natively. Layout 1 is the native single-terminal
 * pipeline (grid machinery fully dormant, local red line byte-identical);
 * layouts 2 / 2×2 overlay a grid of independent xterm tiles, each with its OWN
 * WS bound to its tile key (`sessionId` for a LOCAL tab, `deviceId:sessionId`
 * for a REMOTE one — local tiles hit `/ws/sessions/*` + `/api/sessions/*`,
 * remote tiles hit the fleet proxy). Ported Rev 2 semantics (≤4 tiles, ≤6
 * live instances w/ LRU eviction of unpinned, offline overlay, device-online
 * auto-reconnect, intentional-close flag, surgical DOM teardown via term
 * dispose) live in `openFleetGridTerminal`/`_fleetGridEvictIfNeeded`/
 * `closeFleetGridTerminal`/`_fleetGridReconnectOfflineTiles`. Desktop/tablet
 * only — `setFleetGridLayout` refuses to leave layout 1 on phones.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js (CodemanApp), fleet-api.js (listFleet/fleetStopSession),
 *   constants.js (escapeHtml)
 * @loadorder after fleet-api.js
 */

Object.assign(CodemanApp.prototype, {
  /**
   * One-time bootstrap (called from init(), replaces the old initFleetDashboard).
   * Allocates the registry and pulls the first fleet snapshot. Self-contained —
   * a fleet fetch failure never blocks the local UI (refreshFleetState swallows).
   */
  initFleetTabs() {
    this.fleetTabs = new Map();
    // Keys the user explicitly closed. PERSISTED to localStorage
    // (`codeman:fleet-hidden-tabs`, per-device/client-only) so a close survives
    // reloads — `refreshFleetState` won't re-add a hidden key, and it prunes a
    // key only once its OWNING DEVICE is online AND the session is genuinely
    // gone (see `_pruneFleetHiddenKeys`) so the set can't grow unbounded while
    // still surviving offline→online device cycles.
    this._fleetHidden = this._loadFleetHiddenKeys();
    this.initFleetGrid();
    this.refreshFleetState();
  },

  /** localStorage key for the persistent closed-tab set (per-device, client-only). */
  _FLEET_HIDDEN_STORAGE_KEY: 'codeman:fleet-hidden-tabs',

  /** Read the persisted closed-tab keys into a Set (empty/tolerant on any error). */
  _loadFleetHiddenKeys() {
    try {
      const raw = localStorage.getItem(this._FLEET_HIDDEN_STORAGE_KEY);
      if (!raw) return new Set();
      const arr = JSON.parse(raw);
      return new Set(Array.isArray(arr) ? arr.filter((k) => typeof k === 'string') : []);
    } catch {
      return new Set();
    }
  },

  /** Persist the current closed-tab set as a JSON array (best-effort). */
  _saveFleetHiddenKeys() {
    try {
      localStorage.setItem(this._FLEET_HIDDEN_STORAGE_KEY, JSON.stringify(Array.from(this._fleetHidden || [])));
    } catch {
      /* storage may be unavailable */
    }
  },

  /**
   * Drop hidden keys for sessions that are genuinely gone — bounds the
   * persisted set. `presentKeys` is every current remote (`deviceId:sessionId`)
   * key from `sessionTabs`; `onlineByDevice` maps deviceId → online boolean.
   *
   * CRITICAL: absence from `sessionTabs` is only a positive "gone" signal when
   * the OWNING DEVICE is ONLINE. When a device goes offline (laptop sleep, wifi
   * blip, node restart) the central drops its handle, so ALL its sessions
   * vanish from `sessionTabs` even though they keep running in tmux; the same
   * holds for a first page-load snapshot before a device finishes reconnecting.
   * Pruning then would wipe the hidden markers, and on reconnect the still-
   * running sessions reappear unmarked → the closed tab silently returns,
   * defeating the "关闭持久记住,刷新不再出现" guarantee. So we KEEP a hidden
   * marker whenever its device is offline/unknown, and only prune when the
   * device is confirmed online AND the session is absent from its live list.
   * Persists only when something actually changed.
   */
  _pruneFleetHiddenKeys(presentKeys, onlineByDevice) {
    if (!this._fleetHidden || this._fleetHidden.size === 0) return;
    let changed = false;
    for (const key of Array.from(this._fleetHidden)) {
      const idx = key.indexOf(':');
      if (idx < 0) continue; // not a fleet key — never prune (defensive)
      const deviceId = key.slice(0, idx);
      // Offline/unknown owning device → absence isn't "gone"; keep the marker.
      if (!onlineByDevice || onlineByDevice.get(deviceId) !== true) continue;
      // Device online AND session absent from its live list → genuinely gone.
      if (!presentKeys.has(key)) {
        this._fleetHidden.delete(key);
        changed = true;
      }
    }
    if (changed) this._saveFleetHiddenKeys();
  },

  /**
   * Reopen a fleet session (from the device panel) whose tab was closed: drop it
   * from the persistent hidden set, refresh so `refreshFleetState` re-adds it to
   * the registry, then select it — the user's path back to a closed session.
   * Fleet-only by construction (panel rows are remote sessions); a non-fleet key
   * is ignored, so the local red line is untouched.
   */
  async openFleetSessionTab(key) {
    if (!key || !this._looksLikeFleetKey(key)) return;
    if (this._fleetHidden && this._fleetHidden.has(key)) {
      this._fleetHidden.delete(key);
      this._saveFleetHiddenKeys();
    }
    await this.refreshFleetState();
    if (this.isFleetKey(key)) {
      this.selectSession(key, { forceReload: true });
    } else {
      this.showToast?.('会话不可用', 'warning');
    }
  },

  /** True iff `id` is a remote fleet tab key (present in the registry). */
  isFleetKey(id) {
    return !!(id && this.fleetTabs && this.fleetTabs.has(id));
  },

  /** { deviceId, sessionId } for a fleet key, else null (local ids → null). */
  _fleetTarget(id) {
    const t = this.fleetTabs && this.fleetTabs.get(id);
    return t ? { deviceId: t.deviceId, sessionId: t.sessionId } : null;
  },

  /**
   * Load a replayable terminal buffer, parameterized by tab type. Returns the
   * SAME `{ terminalBuffer, truncated }` shape for local and remote so callers
   * (selectSession / needsRefresh / clearTerminal) stay identical.
   *   - local: `GET /api/sessions/:id/terminal[?tail=N]` (unchanged)
   *   - fleet: `GET /api/fleet/devices/:d/sessions/:s/terminal` → `{ buffer }`
   */
  async _loadTerminalBuffer(id, tail) {
    const f = this._fleetTarget(id);
    if (f) {
      const res = await fetch(
        `/api/fleet/devices/${encodeURIComponent(f.deviceId)}/sessions/${encodeURIComponent(f.sessionId)}/terminal`
      );
      const buffer = (await res.json())?.data?.buffer;
      return { terminalBuffer: buffer || '', truncated: false };
    }
    const q = tail ? `?tail=${tail}` : '';
    const res = await fetch(`/api/sessions/${id}/terminal${q}`);
    return (await res.json())?.data ?? {};
  },

  /**
   * Rebuild the remote-tab registry from `GET /api/fleet` and re-render the tab
   * strip. SSE `fleet:*` events and the initial bootstrap both land here. Never
   * touches `this.sessions`, never calls selectSession — pure tab-strip refresh.
   */
  async refreshFleetState() {
    if (!this.fleetTabs) this.fleetTabs = new Map();
    if (!this._fleetHidden) this._fleetHidden = new Set();
    let state = null;
    try {
      state = await this.listFleet();
    } catch {
      return; // non-fatal — local UI unaffected
    }
    if (!state) return;

    const online = new Map();
    for (const d of state.devices || []) online.set(d.id, d.status === 'online');

    // FleetSessionTab (state.sessionTabs) doesn't carry `adopted` — only
    // FleetSessionSummary (state.sessions) does — so cross-reference by the
    // same `${deviceId}:${id}` key to mark a remote tab as an adopted
    // (foreign-tmux) session for the tab-strip marker (Rev5 §13.3, Task 29).
    const adoptedByKey = new Set();
    for (const s of state.sessions || []) {
      if (s.adopted) adoptedByKey.add(`${s.deviceId}:${s.id}`);
    }

    const next = new Map();
    // Every current remote key from ONLINE devices (offline devices drop out of
    // sessionTabs entirely) — drives the device-online-gated hidden-set prune
    // below so only genuinely-stopped sessions are forgotten (bounded set).
    const presentFleetKeys = new Set();
    for (const tab of state.sessionTabs || []) {
      // Central self device is already rendered as native local tabs.
      if (tab.deviceId === 'local') continue;
      presentFleetKeys.add(tab.key);
      if (this._fleetHidden.has(tab.key)) continue;
      next.set(tab.key, {
        ...tab,
        online: online.get(tab.deviceId) ?? true,
        adopted: adoptedByKey.has(tab.key),
      });
    }
    this.fleetTabs = next;
    this._pruneFleetHiddenKeys(presentFleetKeys, online);

    // Cache the full snapshot for the device panel (Task 19) and drive its
    // header badge + open-panel re-render off the SAME refresh flow. All three
    // are optional-chained so a partial init (panel module not yet mixed in)
    // never breaks the tab-strip refresh.
    this._fleetState = state;
    this._updateFleetBadge?.();
    this._renderFleetPanelIfOpen?.();
    // Homepage device selector (Task 2) tracks the same snapshot — refresh the
    // welcome device row so pills/counts/online-state stay live. Hidden unless a
    // remote device exists, so single-machine users are unaffected.
    this.renderWelcomeDeviceRow?.();
    this.renderWelcomeActiveSessions?.();
    this.syncSystemStatsPolling?.();

    // One-shot re-render: on a fresh page load, the welcome screen's Resume
    // Conversation list can render (loadHistorySessions in terminal-ui.js)
    // BEFORE this first fleet-state arrival — `_fetchRemoteResumeRows` reads
    // `this._fleetState`, which was still unset, so remote candidates came
    // back empty. Now that state has just landed for the first time, if the
    // welcome screen is still showing and has no remote rows, re-run the
    // list exactly once. `_fleetStateLoadedOnce` flips before the call so
    // this can never re-trigger, including from later SSE-driven refreshes.
    if (!this._fleetStateLoadedOnce) {
      this._fleetStateLoadedOnce = true;
      const welcomeVisible = document.getElementById('welcomeOverlay')?.classList.contains('visible');
      const hasRemoteRows = !!document.querySelector('#historyList .history-item-remote');
      if (welcomeVisible && !hasRemoteRows) {
        this.loadHistorySessions();
      }
    }

    // Split-grid (Task 20): a device that just came back online may have
    // pinned tiles still showing their offline overlay — reconnect them. Also
    // refresh live tile titles (a remote tab's status/label may have changed).
    // Both are no-ops while the grid is dormant (layout 1).
    this._fleetGridReconnectOfflineTiles?.();
    this._fleetGridRefreshTitles?.();

    // If the active tab was a remote one that vanished (device removed / session
    // gone), release the terminal and fall back to a local tab or the welcome.
    if (this.activeSessionId && !next.has(this.activeSessionId) && this._looksLikeFleetKey(this.activeSessionId)) {
      this._disconnectWs();
      this.activeSessionId = null;
      if (this.sessionOrder && this.sessionOrder.length > 0 && this.sessions.size > 0) {
        this.selectSession(this.sessionOrder[0]);
      } else {
        try {
          this.terminal?.clear();
        } catch {
          /* terminal may not be ready */
        }
        this.showWelcome?.();
      }
    }

    this._fullRenderSessionTabs();
  },

  /**
   * Heuristic used ONLY when a key has already left the registry (so isFleetKey
   * can't answer): a fleet key is `${deviceId}:${sessionId}`. Local session ids
   * are UUIDs with no colon, so a colon reliably distinguishes a dropped remote
   * tab from a local one for the "active tab vanished" fallback above.
   */
  _looksLikeFleetKey(id) {
    return typeof id === 'string' && id.includes(':');
  },

  /**
   * Close (hide) a remote tab locally. Per spec §6.1 this only affects local
   * visibility — the remote session keeps running; stopping it is the explicit
   * `stopFleetSession()`. The hidden key is PERSISTED (localStorage) so the
   * close survives reloads; the device panel offers a reopen path
   * (`openFleetSessionTab`).
   */
  closeFleetTab(key) {
    if (!this.isFleetKey(key)) return;
    this._fleetHidden.add(key);
    this._saveFleetHiddenKeys();
    this.fleetTabs.delete(key);
    if (this.activeSessionId === key) {
      this._disconnectWs();
      this.activeSessionId = null;
      try {
        localStorage.removeItem('codeman-active-session');
      } catch {
        /* storage may be unavailable */
      }
      if (this.sessionOrder && this.sessionOrder.length > 0 && this.sessions.size > 0) {
        this.selectSession(this.sessionOrder[0]);
      } else {
        try {
          this.terminal?.clear();
        } catch {
          /* terminal may not be ready */
        }
        this.showWelcome?.();
      }
    }
    this._fullRenderSessionTabs();
    this._updateFleetBadge?.();
    this._renderFleetPanelIfOpen?.();
    this.renderWelcomeDeviceRow?.();
    this.renderWelcomeActiveSessions?.();
    this.showToast?.('Tab hidden, session still running', 'info');
  },

  /**
   * Remove a stopped/removed fleet session from every cached UI surface
   * immediately. The authoritative SSE refresh still arrives later, but the
   * user already got a successful DELETE response, so keeping the row visible
   * until a manual refresh makes the UI feel dishonest.
   */
  _dropFleetSessionFromUi(key) {
    if (!key || !this._looksLikeFleetKey(key)) return;
    const target =
      this._fleetTarget(key) ||
      (() => {
        const idx = String(key).indexOf(':');
        return idx > 0 ? { deviceId: String(key).slice(0, idx), sessionId: String(key).slice(idx + 1) } : null;
      })();
    if (!target) return;

    this.fleetTabs?.delete(key);
    if (this._fleetHidden?.delete(key)) this._saveFleetHiddenKeys();

    if (this._fleetState) {
      if (Array.isArray(this._fleetState.sessions)) {
        this._fleetState.sessions = this._fleetState.sessions.filter(
          (s) => !(s && s.deviceId === target.deviceId && s.id === target.sessionId)
        );
      }
      if (Array.isArray(this._fleetState.sessionTabs)) {
        this._fleetState.sessionTabs = this._fleetState.sessionTabs.filter((tab) => tab && tab.key !== key);
      }
      if (Array.isArray(this._fleetState.devices)) {
        for (const d of this._fleetState.devices) {
          if (!d || d.id !== target.deviceId) continue;
          const remaining = Array.isArray(this._fleetState.sessions)
            ? this._fleetState.sessions.filter((s) => s && s.deviceId === target.deviceId).length
            : Math.max(0, Number(d.activeSessionCount || 0) - 1);
          d.activeSessionCount = remaining;
        }
      }
    }

    if (this.activeSessionId === key) {
      this._disconnectWs();
      this.activeSessionId = null;
      try {
        localStorage.removeItem('codeman-active-session');
      } catch {
        /* storage may be unavailable */
      }
      if (this.sessionOrder && this.sessionOrder.length > 0 && this.sessions.size > 0) {
        this.selectSession(this.sessionOrder[0]);
      } else {
        try {
          this.terminal?.clear();
        } catch {
          /* terminal may not be ready */
        }
        this.showWelcome?.();
      }
    }

    this._fullRenderSessionTabs?.();
    this._updateFleetBadge?.();
    this._renderFleetPanelIfOpen?.();
    this.renderWelcomeDeviceRow?.();
    this.renderWelcomeActiveSessions?.();
  },

  /**
   * Explicitly STOP a remote session on its device (DELETE via fleet-api). The
   * device panel (Task 19) wires this to a button; exposed here so the capability
   * exists in this task. On success the node broadcasts fleet:sessions-updated,
   * which drives refreshFleetState and drops the tab.
   */
  async stopFleetSession(key) {
    const f = this._fleetTarget(key);
    if (!f) return;
    const tab = this.fleetTabs?.get(key);
    const adopted = tab?.adopted ?? false;
    try {
      await this.fleetStopSession(f.deviceId, f.sessionId);
      this._dropFleetSessionFromUi(key);
      const msg = adopted ? '已从 Codeman 移除(tmux 会话未受影响)' : 'Remote session stopped';
      this.showToast?.(msg, 'success');
    } catch {
      const msg = adopted ? '移除失败' : 'Failed to stop remote session';
      this.showToast?.(msg, 'error');
    }
  },

  /**
   * Build the markup for one remote tab. Mirrors the native `.session-tab`
   * structure (status dot + mode badge + name) but trimmed: no tab-number
   * (Alt+N maps to local sessionOrder only), no gear/detach/task/subagent
   * badges (Claude-specific). Every remote-origin string is escaped. An
   * adopted (foreign-tmux) session gets a 🔗 marker (`tab.adopted`, merged in
   * by `refreshFleetState` from `state.sessions` — Rev5 §13.3, Task 29); its ×
   * always closes via `requestCloseSession`/`closeFleetTab`, which for ANY
   * fleet tab already only hides it locally (title says as much) — no
   * separate copy fix needed here, unlike the explicit stop-session action in
   * the device panel.
   */
  _fleetTabHtml(key, tab) {
    const isActive = key === this.activeSessionId;
    const status = tab.status || 'idle';
    // Offline device → grey/dim dot (reuse the native `.tab-status.ended` look);
    // online → the session's own idle/busy/error color. All existing CSS vars.
    const dotClass = tab.online === false ? 'ended' : status;
    const mode = tab.mode || 'claude';
    const modeBadge = codemanModeBadgeHtml(mode);
    const devicePill = codemanDevicePillHtml(tab.deviceName || tab.deviceId || 'remote', 'remote');
    const remark = typeof tab.remark === 'string' ? tab.remark.trim() : '';
    const remarkBadge = remark ? `<span class="tab-remark" title="Session remark">${escapeHtml(remark)}</span>` : '';
    const adoptedBadge = tab.adopted
      ? '<span class="tab-adopted-badge" title="收编的外部 tmux 会话 · Adopted external tmux session" aria-hidden="true">\u{1F517}</span>'
      : '';
    const keyJson = escapeHtml(JSON.stringify(key));
    const primaryLabel = tab.sessionLabel || tab.sessionId || key;
    const gitSummary = codemanGitSummaryHtml(tab.gitSummary);
    const titleAttr = [tab.deviceName, mode, remark, tab.sessionLabel, tab.workingDir].filter(Boolean).join(' · ');
    return `<div class="session-tab fleet-tab ${isActive ? 'active' : ''}${tab.online === false ? ' fleet-offline' : ''}" data-id="${escapeHtml(key)}" data-fleet="1" onclick="app.handleSessionTabClick(event, ${keyJson})" tabindex="0" role="tab" aria-selected="${isActive ? 'true' : 'false'}" aria-label="${escapeHtml(tab.title || key)} remote session" title="${escapeHtml(titleAttr)}">
        <span class="tab-status ${dotClass}" aria-hidden="true"></span>
        <span class="tab-info">
          <span class="tab-name-row">
            ${devicePill}
            ${modeBadge}
            ${adoptedBadge}
            ${remarkBadge}
            ${primaryLabel ? `<span class="tab-name">${escapeHtml(primaryLabel)}</span>` : ''}
          </span>
          ${tab.workingDir ? `<span class="tab-folder">\u{1F4C1} ${escapeHtml(tab.workingDir)}</span>` : ''}
          ${gitSummary}
        </span>
        <span class="tab-close" onclick="event.stopPropagation(); app.requestCloseSession(${keyJson})" title="Close tab (session keeps running)" aria-label="Close remote tab" tabindex="0">&times;</span>
      </div>`;
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// Split-grid (Task 20, spec §6.3) — native re-implementation of the deleted
// Rev 2 grid. Layout 1 = the native single-terminal pipeline, fully dormant
// (every method below early-returns while `_fleetGridLayout === 1`, so the
// local red line stays byte-identical). Layouts 2 / 2×2 overlay `#fleetGrid`
// (anchored to the position:relative `.main`, above the welcome overlay) with
// independent xterm tiles, each with its OWN WebSocket bound to its tile key.
//
// Tile key: a LOCAL session id (no colon) OR a REMOTE `deviceId:sessionId`.
// `_fleetGridTileTarget()` maps the key to local `/ws/sessions/*` +
// `/api/sessions/*` or the remote fleet proxy. Everything else (eviction,
// offline overlay, reconnect, intentional-close, surgical teardown) is ported
// from Rev 2's `55ff739` fleet-dashboard.js.
// ═══════════════════════════════════════════════════════════════════════════
Object.assign(CodemanApp.prototype, {
  /** One-time grid state bootstrap (called from initFleetTabs). */
  initFleetGrid() {
    this._fleetGridLayout = 1; // slot count: 1 (native) | 2 | 4
    this._fleetGridPinned = [null]; // _fleetGridPinned[i] = tile key or null
    this._fleetGridTerms = new Map(); // key -> { term, fit, ws, el, ... }
    this._fleetGridLru = new Map(); // key -> last-touch ms (≤6 eviction)
    this._fleetGridFocusedIndex = 0;
    this._fleetGridWired = false;
    this._fleetGridUpdateControl();
  },

  /** True while a multi-tile grid is showing (2 / 2×2). */
  _fleetGridActive() {
    return this._fleetGridLayout > 1;
  },

  /** Phone breakpoint (spec §6.3: grid is desktop/tablet only). */
  _isPhone() {
    return (
      typeof MobileDetection !== 'undefined' &&
      MobileDetection.getDeviceType &&
      MobileDetection.getDeviceType() === 'mobile'
    );
  },

  /**
   * Switch the grid to 1 / 2 / 2×2. Phones are forced to layout 1. Surviving
   * pinned keys carry into the earliest slots; growing from layout 1 seeds
   * slot 0 with the currently active tab. Anything that falls off the end is
   * torn down. Layout 1 tears down ALL tiles and hands back to the native
   * single terminal underneath (untouched → no refit needed).
   */
  setFleetGridLayout(n) {
    n = Number(n);
    if (n !== 1 && n !== 2 && n !== 4) return;
    if (this._isPhone()) {
      if (n !== 1) this.showToast?.('分屏在手机上不可用 · Split-screen is desktop only', 'info');
      n = 1;
    }
    const grid = document.getElementById('fleetGrid');
    if (!grid) return;
    const gridDomActive =
      grid.classList.contains('active') || grid.getAttribute('data-layout') !== null || grid.innerHTML.trim() !== '';
    if (n === this._fleetGridLayout && !(n === 1 && gridDomActive)) {
      this._fleetGridUpdateControl();
      return;
    }

    const wasLayout1 = this._fleetGridLayout === 1;
    const carried = wasLayout1 ? [this.activeSessionId || null] : (this._fleetGridPinned || []).slice();

    if (n === 1) {
      // Tear down every tile — the native terminal takes over.
      for (const key of Array.from(this._fleetGridTerms.keys())) this.closeFleetGridTerminal(key);
      this._fleetGridLru?.clear?.();
      this._fleetGridLayout = 1;
      this._fleetGridPinned = [null];
      this._fleetGridFocusedIndex = 0;
      grid.classList.remove('active');
      grid.removeAttribute('data-layout');
      grid.setAttribute('aria-hidden', 'true');
      grid.innerHTML = '';
      this._fleetGridUpdateControl();
      this._disposeMainTerminalWebglAfterGrid?.();
      // The native terminal was never resized while covered; a defensive refit
      // keeps it crisp on return (server-side no-op if dims match).
      try {
        this.fitAddon?.fit();
      } catch {
        /* not measurable */
      }
      // The native WS was suspended on the way INTO the grid (below) so it
      // wouldn't fight the tiles' own WS for the same session's desktop-sizing
      // claim (session.resize is last-writer-wins). Reconnect it now via the
      // SAME path selectSession uses on an ordinary tab click (_connectWs +
      // buffer refresh + refit) — the goal is for this tab to land in exactly
      // the state it would be in had the user just clicked it. No-op if the
      // grid was opened with no active session (e.g. from the welcome screen).
      if (this.activeSessionId) {
        this.selectSession(this.activeSessionId, { forceReload: true, forceResize: true }).catch(() => {});
      }
      return;
    }

    const nextPinned = new Array(n).fill(null);
    for (let i = 0; i < n; i++) nextPinned[i] = carried[i] || null;
    // Shrink: close whatever falls off the end of the carried array.
    for (let i = n; i < carried.length; i++) {
      const key = carried[i];
      if (key) {
        this.closeFleetGridTerminal(key);
        this._fleetGridLru?.delete(key);
      }
    }
    // Growing OUT of the native single-terminal view (layout 1 → 2/2×2): the
    // active session is about to be pinned into tile 0 with its OWN dedicated
    // WS, but the native terminal's WS (still bound to activeSessionId, still
    // holding a desktop-sizing claim) was never told to let go — two live
    // desktop claims on the same session then race in session.resize
    // (last-writer-wins, transient mis-render), and a second of the
    // MAX_WS_PER_SESSION slots is silently burned. Suspend the native WS now,
    // before any tile WS opens, so there is no window where both exist. The
    // native terminal DOM itself is untouched underneath — the grid overlay
    // simply covers it.
    if (wasLayout1) this._disconnectWs();
    this._fleetGridLayout = n;
    this._fleetGridPinned = nextPinned;
    this._fleetGridFocusedIndex = 0;
    grid.classList.add('active');
    grid.setAttribute('data-layout', String(n));
    grid.setAttribute('aria-hidden', 'false');
    grid.innerHTML = nextPinned.map((_, i) => this._fleetGridTileShellHtml(i)).join('');
    this._fleetGridWireControl();
    this._fleetGridUpdateControl();
    this._fleetGridRenderTiles();
  },

  /** Sync the header segmented control's active/aria-pressed state. */
  _fleetGridUpdateControl() {
    const seg = document.getElementById('gridLayoutSeg');
    if (!seg) return;
    seg.querySelectorAll('[data-grid-layout]').forEach((btn) => {
      const on = Number(btn.dataset.gridLayout) === this._fleetGridLayout;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  },

  /** Attach the delegated grid click handler exactly once. */
  _fleetGridWireControl() {
    if (this._fleetGridWired) return;
    const grid = document.getElementById('fleetGrid');
    if (!grid) return;
    this._fleetGridWired = true;
    grid.addEventListener('click', (e) => this._onFleetGridClick(e));
  },

  _onFleetGridClick(e) {
    const unpinBtn = e.target.closest('[data-action="unpin-grid-tile"]');
    if (unpinBtn) {
      const idx = Number(unpinBtn.dataset.index);
      if (Number.isInteger(idx)) this.unpinFleetGridTile(idx);
      return;
    }
    const tile = e.target.closest('.fleet-grid-tile[data-tile-index]');
    if (!tile) return;
    const idx = Number(tile.dataset.tileIndex);
    if (!Number.isInteger(idx)) return;
    this._fleetGridFocusTile(idx);
    const key = this._fleetGridPinned[idx];
    if (key) this._fleetGridTouch(key);
  },

  _fleetGridTileShellHtml(i) {
    return `<div class="fleet-grid-tile" id="fleet-grid-tile-${i}" data-tile-index="${i}">
      <div class="fleet-grid-tile-head"></div>
      <div class="fleet-grid-tile-body" id="fleet-grid-tile-${i}-body"></div>
    </div>`;
  },

  /**
   * Grid entry point invoked by `handleSessionTabClick`: while a multi-tile
   * grid is active a tab click PINS instead of selecting into the single view.
   * Returns true iff it handled the click (so the caller returns early). No-op
   * → false while dormant, keeping the local single-view path byte-identical.
   */
  _maybePinToGrid(key) {
    if (!this._fleetGridActive()) return false;
    this.pinFleetGridTab(key);
    return true;
  },

  /**
   * Pin `key` into the first empty slot (or evict the least-recently-used
   * pinned slot when full). A double-pin focuses the existing tile + hints,
   * never creating a second instance of the same session.
   */
  pinFleetGridTab(key) {
    if (!key || !this._fleetGridActive()) return;
    if (!Array.isArray(this._fleetGridPinned) || this._fleetGridPinned.length !== this._fleetGridLayout) {
      this._fleetGridPinned = new Array(this._fleetGridLayout).fill(null);
    }
    const existingIdx = this._fleetGridPinned.indexOf(key);
    if (existingIdx !== -1) {
      this.showToast?.('已在分屏中 · Already pinned', 'info');
      this._fleetGridFocusTile(existingIdx);
      this._fleetGridTouch(key);
      return;
    }
    let slot = this._fleetGridPinned.indexOf(null);
    if (slot === -1) {
      slot = this._fleetGridOldestPinnedSlot();
      const evicted = this._fleetGridPinned[slot];
      if (evicted) {
        this.closeFleetGridTerminal(evicted);
        this._fleetGridLru?.delete(evicted);
      }
    }
    this._fleetGridPinned[slot] = key;
    this._fleetGridFocusedIndex = slot;
    this._fleetGridRenderTiles();
  },

  /** Clear grid slot `index`, tearing down its terminal/WS if occupied. */
  unpinFleetGridTile(index) {
    if (!Array.isArray(this._fleetGridPinned) || index < 0 || index >= this._fleetGridPinned.length) return;
    const key = this._fleetGridPinned[index];
    this._fleetGridPinned[index] = null;
    if (key) {
      this.closeFleetGridTerminal(key);
      this._fleetGridLru?.delete(key);
    }
    this._fleetGridRenderTiles();
  },

  /** (Re)populate every tile's header + terminal from `_fleetGridPinned`. */
  _fleetGridRenderTiles() {
    if (!this._fleetGridActive() || !Array.isArray(this._fleetGridPinned)) return;
    for (let i = 0; i < this._fleetGridPinned.length; i++) {
      const key = this._fleetGridPinned[i];
      const tileEl = document.getElementById(`fleet-grid-tile-${i}`);
      const bodyEl = document.getElementById(`fleet-grid-tile-${i}-body`);
      if (!tileEl || !bodyEl) continue;
      const headEl = tileEl.querySelector('.fleet-grid-tile-head');
      tileEl.classList.toggle('focused', i === this._fleetGridFocusedIndex);
      if (!key) {
        tileEl.classList.add('empty');
        if (headEl) headEl.innerHTML = '';
        bodyEl.innerHTML =
          '<div class="fleet-grid-empty-hint">空位 · 点击上方标签页钉入此格<br>Empty · click a session tab to pin here</div>';
        continue;
      }
      tileEl.classList.remove('empty');
      // Title is the ONLY place a remote (untrusted) string reaches the DOM →
      // escapeHtml. The unpin × is a static control.
      if (headEl) {
        headEl.innerHTML = `<span class="fleet-grid-tile-title">${escapeHtml(
          this._fleetGridTileTitle(key)
        )}</span><button type="button" class="fleet-grid-tile-close" data-action="unpin-grid-tile" data-index="${i}" aria-label="取消钉选 · Unpin" title="取消钉选 · Unpin">&times;</button>`;
      }
      this._fleetGridOpenTile(key, bodyEl);
    }
  },

  /** Human title for a tile key (local session name or remote tab title). */
  _fleetGridTileTitle(key) {
    const local = this.sessions && this.sessions.get(key);
    if (local) return (this.getSessionName && this.getSessionName(local)) || local.name || key;
    const tab = this.fleetTabs && this.fleetTabs.get(key);
    if (tab) return tab.title || `${tab.deviceName || ''} / ${tab.sessionLabel || ''}` || key;
    return key;
  },

  /**
   * Resolve a tile key to its terminal endpoints. Local keys (a plain session
   * id) hit the native `/ws/sessions/*` + `/api/sessions/*`; remote keys resolve
   * via the fleet registry to the fleet proxy.
   */
  _fleetGridTileTarget(key) {
    const f = this._fleetTarget ? this._fleetTarget(key) : null;
    if (f) {
      return {
        kind: 'remote',
        deviceId: f.deviceId,
        sessionId: f.sessionId,
        wsPath: `/ws/fleet/devices/${encodeURIComponent(f.deviceId)}/sessions/${encodeURIComponent(
          f.sessionId
        )}/terminal`,
      };
    }
    return {
      kind: 'local',
      wsPath: `/ws/sessions/${encodeURIComponent(key)}/terminal`,
      bufferUrl: `/api/sessions/${encodeURIComponent(key)}/terminal`,
    };
  },

  /** Best-effort replay buffer for a tile (handles both envelope shapes). */
  async _fleetGridFetchBuffer(target) {
    try {
      if (target.kind === 'remote') {
        const res = await this.fleetTerminalBuffer(target.deviceId, target.sessionId);
        return (res && res.buffer) || '';
      }
      const res = await fetch(target.bufferUrl);
      const data = (await res.json())?.data;
      return (data && data.terminalBuffer) || '';
    } catch {
      return '';
    }
  },

  /** openFleetGridTerminal + LRU bookkeeping + ≤6 eviction (every tile open). */
  _fleetGridOpenTile(key, containerEl) {
    // Self-heal against native-WS resurrection: selectSession stays reachable
    // while the grid is active (closeFleetTab active-tab fallback, vanished-
    // remote-tab fallback, session-create flows) and reconnects the native WS
    // + full-dims desktop claim under the overlay. If THAT session is about to
    // get a tile (with its own WS + tile-dims claim), drop the native socket
    // first — restoring the invariant that a pinned session's only live socket
    // is its tile's. Every tile open funnels through here, so every
    // resurrection path is healed at the exact moment it would matter.
    if (key === this._wsSessionId) this._disconnectWs?.();
    this.openFleetGridTerminal(key, containerEl);
    this._fleetGridTouch(key);
    this._fleetGridEvictIfNeeded();
  },

  /**
   * Open (or re-attach) the terminal for `key` inside `containerEl`. A closed/
   * closing WS can never be reused — tear the dead rec down and rebuild. An
   * in-flight ws (`null`, buffer fetch not yet done) counts as healthy (0), as
   * do CONNECTING (0) / OPEN (1) — those re-attach. Exception: a rec whose
   * local-session attach POST failed (`attachFailed`, ws still `null`) is DEAD,
   * not in-flight — tear it down so the rebuild retries the attach; otherwise
   * every re-render would re-adopt the stale failure overlay forever.
   */
  async openFleetGridTerminal(key, containerEl) {
    if (!key || !containerEl) return;
    const existing = this._fleetGridTerms.get(key);
    if (existing) {
      const wsState = existing.ws ? existing.ws.readyState : 0;
      if (existing.attachFailed || (wsState !== 0 && wsState !== 1)) {
        this.closeFleetGridTerminal(key);
      } else {
        return this._fleetGridReattach(existing, key, containerEl);
      }
    }
    const target = this._fleetGridTileTarget(key);
    if (!target) return;
    await this._fleetGridCreateTerminal(key, target, containerEl);
  },

  /** Re-attach a live `rec` into a rebuilt tile body (DOM relocate + RO rebind). */
  _fleetGridReattach(existing, key, containerEl) {
    const node = existing.term.element;
    if (node && node.parentElement !== containerEl) {
      containerEl.innerHTML = '';
      containerEl.appendChild(node);
    }
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
          this._fleetGridSendResize(key);
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
    this._fleetGridSendResize(key);
    if (existing.offline) this._fleetGridMarkOffline(key);
  },

  /** Build a brand-new xterm + dedicated WS for `key` (input bound to THIS socket). */
  async _fleetGridCreateTerminal(key, target, containerEl) {
    containerEl.innerHTML = '';
    const term = new Terminal({
      scrollback: 5000,
      allowProposedApi: true,
      fontFamily: '"Fira Code", "Cascadia Code", "JetBrains Mono", "SF Mono", Monaco, monospace',
      fontSize: 12,
      lineHeight: 1.2,
      cursorBlink: false,
      allowTransparency: true,
      theme: window.codemanCurrentXtermTheme ? { ...window.codemanCurrentXtermTheme() } : undefined,
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(containerEl);
    try {
      fit.fit();
    } catch {
      /* not measurable yet */
    }

    const rec = {
      term,
      fit,
      ws: null, // in-flight until assigned below → treated as healthy on reattach
      el: containerEl,
      seq: 0,
      cid: `grid-${Math.random().toString(36).slice(2, 10)}`,
      resizeObserver: null,
      offline: false,
      offlineEl: null,
      intentionalClose: false,
      offlineMessage: null,
      attachFailed: false, // true = local attach POST failed; ws stays null but rec is DEAD, not in-flight
    };
    this._fleetGridTerms.set(key, rec);

    // Grid-only path (never reached in layout 1 — _fleetGridCreateTerminal is
    // only invoked from the grid-active render/reconnect paths): a LOCAL tile
    // key (target.kind === 'local' — i.e. not isFleetKey-shaped, no deviceId
    // prefix) whose session has no live PTY (pid === null — restored after a
    // server restart and never selected in single view). Mirror selectSession's
    // re-attach call (app.js `pid === null` branch) BEFORE opening the tile WS;
    // otherwise the WS opens fine against a session with no PTY — empty buffer,
    // input silently dropped, no on-tile hint.
    //
    // REMOTE tiles are deliberately NOT handled here, even though a remote
    // session can also end up pid === null (a node restarts and restores its
    // own sessions too): there is no fleet endpoint to attach/start an
    // existing remote session, so re-attach isn't possible client-side. A
    // detached-vs-live hint isn't wired in either — `target` (from
    // `_fleetGridTileTarget`) and `this.fleetTabs` (the registry this module
    // owns) only carry `status`, which stays 'idle' whether or not pid is
    // null (see session.ts / sessionStatusForFleet), so it can't distinguish
    // the two cases. `pid` DOES exist one layer out, in the separately-cached
    // `this._fleetState.sessions` (FleetSessionSummary[]) — but wiring a hint
    // through that would mean flagging the tile via `_fleetGridMarkOffline`
    // (`rec.offline = true`), and `_fleetGridReconnectOfflineTiles` treats
    // ANY offline-flagged tile on an online device as reconnectable, re-
    // closing+reopening it on every `fleet:sessions-updated` broadcast (which
    // fires on the node's heartbeat/session-update cadence, not just device
    // online transitions) — a reconnect loop for a tile that was never
    // actually disconnected. Left as a documented follow-up rather than risking
    // that regression in this bounded fix.
    if (target.kind === 'local') {
      const session = this.sessions.get(key);
      if (session && session.pid === null) {
        try {
          const endpoint = session.mode === 'shell' ? `/api/sessions/${key}/shell` : `/api/sessions/${key}/interactive`;
          await fetch(endpoint, { method: 'POST' });
          session.status = 'busy';
        } catch (err) {
          console.error('Failed to attach unattached local session for grid tile:', err);
          // Tile may have been evicted/closed during the await.
          if (this._fleetGridTerms.get(key) === rec) {
            // Mark the rec DEAD (ws stays null, which alone would read as
            // "in-flight" to openFleetGridTerminal's liveness check) so the
            // next grid re-render tears it down and RETRIES the attach,
            // instead of re-adopting this failure overlay forever.
            rec.attachFailed = true;
            this._fleetGridMarkOffline(key, '会话启动失败 · Failed to start');
          }
          this.showToast?.('会话启动失败 · Failed to start', 'error');
          return;
        }
        // Tile may have been evicted/closed during the attach await.
        if (this._fleetGridTerms.get(key) !== rec) return;
      }
    }

    const buf = await this._fleetGridFetchBuffer(target);
    // The tile may have been evicted/closed during the await — bail if so.
    if (this._fleetGridTerms.get(key) !== rec) return;
    if (buf) {
      try {
        term.write(buf);
      } catch {
        /* ignore */
      }
    }

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}${target.wsPath}`;
    const ws = new WebSocket(url);
    rec.ws = ws;
    ws.onopen = () => this._fleetGridSendResize(key);
    ws.onmessage = (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.t === 'o') term.write(m.d);
      else if (m.t === 'c') term.clear();
      else if (m.t === 'r') this._fleetGridRefreshBuffer(key);
      // m.t === 'ia' (input ack): no local pending queue to reconcile here.
    };
    ws.onclose = (ev) => {
      // Intentional teardown → no overlay. Any other close (device offline,
      // per-IP cap 4008, drop/restart) → recoverable overlay. Messages are
      // static literals (no interpolation) to preserve XSS discipline.
      if (rec.intentionalClose) return;
      const message = ev && ev.code === 4008 ? '连接数已达上限 · Too many connections' : '连接已断开 · Disconnected';
      this._fleetGridMarkOffline(key, message);
    };
    ws.onerror = () => {
      /* surfaced via onclose */
    };

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
        this._fleetGridSendResize(key);
      });
      ro.observe(containerEl);
      rec.resizeObserver = ro;
    }
  },

  /** Fit + typed resize on this tile's OWN WS ({t:'z',v:'desktop'} → claimDesktopSizing). */
  _fleetGridSendResize(key) {
    const rec = this._fleetGridTerms.get(key);
    if (!rec || !rec.ws || rec.ws.readyState !== 1) return;
    const cols = rec.term.cols;
    const rows = rec.term.rows;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return;
    rec.ws.send(JSON.stringify({ t: 'z', c: cols, r: rows, v: 'desktop' }));
  },

  async _fleetGridRefreshBuffer(key) {
    const rec = this._fleetGridTerms.get(key);
    if (!rec) return;
    const target = this._fleetGridTileTarget(key);
    if (!target) return;
    const buf = await this._fleetGridFetchBuffer(target);
    try {
      rec.term.reset();
      if (buf) rec.term.write(buf);
    } catch {
      /* keep whatever is on screen */
    }
  },

  /** Paint/refresh this tile's offline overlay (textContent only → XSS-safe). */
  _fleetGridMarkOffline(key, message) {
    const rec = this._fleetGridTerms.get(key);
    if (!rec) return;
    rec.offline = true;
    if (typeof message === 'string') rec.offlineMessage = message;
    const overlayText = rec.offlineMessage || '设备已离线 · Device offline';
    const node = rec.term && rec.term.element;
    // Only paint when this terminal's own node actually lives in rec.el (guards
    // the reattach window where the node has been relocated).
    if (!rec.el || !node || node.parentElement !== rec.el) return;
    const existing = rec.el.querySelector('.tile-offline');
    if (existing) {
      existing.textContent = overlayText;
      return;
    }
    const overlay = document.createElement('div');
    overlay.className = 'tile-offline';
    overlay.textContent = overlayText;
    rec.el.appendChild(overlay);
    rec.offlineEl = overlay;
  },

  /** Surgical teardown: dispose the term (removes only its own node), close WS. */
  closeFleetGridTerminal(key) {
    const rec = this._fleetGridTerms.get(key);
    if (!rec) return;
    // Mark BEFORE closing so this rec's onclose treats the close as intentional
    // and skips the recoverable overlay.
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
      // xterm's dispose() detaches ONLY this terminal's own element — never
      // blanket-clear rec.el (a sibling tile could be relocated through it).
      rec.term.dispose();
    } catch {
      /* ignore */
    }
    if (rec.offlineEl && rec.offlineEl.parentElement) {
      rec.offlineEl.parentElement.removeChild(rec.offlineEl);
    }
    this._fleetGridTerms.delete(key);
  },

  _fleetGridTouch(key) {
    if (!this._fleetGridLru) this._fleetGridLru = new Map();
    this._fleetGridLru.set(key, Date.now());
  },

  _fleetGridOldestPinnedSlot() {
    let slot = 0;
    let oldest = Infinity;
    for (let i = 0; i < this._fleetGridPinned.length; i++) {
      const k = this._fleetGridPinned[i];
      if (!k) return i;
      const t = (this._fleetGridLru && this._fleetGridLru.get(k)) || 0;
      if (t < oldest) {
        oldest = t;
        slot = i;
      }
    }
    return slot;
  },

  /** Visual-only tile focus (keyboard focus stays with the xterm itself). */
  _fleetGridFocusTile(index) {
    this._fleetGridFocusedIndex = index;
    const grid = document.getElementById('fleetGrid');
    if (!grid) return;
    grid.querySelectorAll('.fleet-grid-tile').forEach((el) => el.classList.remove('focused'));
    const tile = document.getElementById(`fleet-grid-tile-${index}`);
    if (tile) tile.classList.add('focused');
  },

  /**
   * Cap live tile WS at 6 (spec §6.3 — mirrors the central controller's ≤6
   * concurrency ceiling). Pinned keys are exempt; among the rest, close the
   * least-recently-used first. Structurally rare (≤4 tiles) — a defensive
   * guard that self-corrects any future over-open path.
   */
  _fleetGridEvictIfNeeded() {
    if (!this._fleetGridTerms) return;
    const pinnedSet = new Set((this._fleetGridPinned || []).filter(Boolean));
    while (this._fleetGridTerms.size > 6) {
      let oldestKey = null;
      let oldestTime = Infinity;
      for (const key of this._fleetGridTerms.keys()) {
        if (pinnedSet.has(key)) continue;
        const t = (this._fleetGridLru && this._fleetGridLru.get(key)) || 0;
        if (t < oldestTime) {
          oldestTime = t;
          oldestKey = key;
        }
      }
      if (!oldestKey) break; // everything left is pinned — can't evict further
      this.closeFleetGridTerminal(oldestKey);
      this._fleetGridLru?.delete(oldestKey);
    }
  },

  /**
   * A device coming back online (SSE fleet:device-online → refreshFleetState →
   * here) may leave REMOTE tiles showing a stale offline overlay from their
   * permanently-closed WS. A closed WebSocket cannot be reused, so "reconnect"
   * = full close + reopen. Local tiles have no device signal → left as-is.
   */
  _fleetGridReconnectOfflineTiles() {
    if (!this._fleetGridActive() || !this._fleetState || !Array.isArray(this._fleetGridPinned)) return;
    const devicesById = new Map((this._fleetState.devices || []).map((d) => [d.id, d]));
    this._fleetGridPinned.forEach((key, index) => {
      if (!key) return;
      const rec = this._fleetGridTerms.get(key);
      if (!rec || !rec.offline) return;
      const target = this._fleetGridTileTarget(key);
      if (!target || target.kind !== 'remote') return;
      const device = devicesById.get(target.deviceId);
      if (!device || device.status !== 'online') return;
      this.closeFleetGridTerminal(key);
      const bodyEl = document.getElementById(`fleet-grid-tile-${index}-body`);
      if (bodyEl) this._fleetGridOpenTile(key, bodyEl);
    });
  },

  /** Refresh live tile-header titles on a fleet-state change (textContent → safe). */
  _fleetGridRefreshTitles() {
    if (!this._fleetGridActive() || !Array.isArray(this._fleetGridPinned)) return;
    for (let i = 0; i < this._fleetGridPinned.length; i++) {
      const key = this._fleetGridPinned[i];
      if (!key) continue;
      const tileEl = document.getElementById(`fleet-grid-tile-${i}`);
      if (!tileEl) continue;
      const titleEl = tileEl.querySelector('.fleet-grid-tile-title');
      if (titleEl) titleEl.textContent = this._fleetGridTileTitle(key);
    }
  },

  /** A local session was removed (deleted/exited) → free its tile if pinned. */
  _fleetGridOnLocalSessionRemoved(sessionId) {
    if (!this._fleetGridActive() || !Array.isArray(this._fleetGridPinned)) return;
    const idx = this._fleetGridPinned.indexOf(sessionId);
    if (idx !== -1) this.unpinFleetGridTile(idx);
  },

  /** Viewport crossed into the phone breakpoint → collapse the grid (spec §6.3). */
  _fleetOnViewportResize() {
    if (this._fleetGridActive() && this._isPhone()) this.setFleetGridLayout(1);
  },
});
