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
 *   `this.fleetTabs` — Map<key, FleetSessionTab+{online}>, key = `${deviceId}:${sessionId}`.
 *   Populated by `refreshFleetState()` from `GET /api/fleet` (`sessionTabs`),
 *   EXCLUDING the central self device (`deviceId === 'local'`; its sessions are
 *   already native local tabs) and user-hidden keys (`this._fleetHidden`).
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
 * device panel in Task 19). The split-grid is intentionally gone here — it is
 * re-added natively in Task 20.
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
    // Keys the user explicitly closed this browser session. `refreshFleetState`
    // won't re-add them (close = local visibility only; a reload forgets it).
    this._fleetHidden = new Set();
    this.refreshFleetState();
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

    const next = new Map();
    for (const tab of state.sessionTabs || []) {
      // Central self device is already rendered as native local tabs.
      if (tab.deviceId === 'local') continue;
      if (this._fleetHidden.has(tab.key)) continue;
      next.set(tab.key, { ...tab, online: online.get(tab.deviceId) ?? true });
    }
    this.fleetTabs = next;

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
   * `stopFleetSession()`. The hidden key is remembered for the browser session
   * so the next fleet refresh won't re-add it.
   */
  closeFleetTab(key) {
    if (!this.isFleetKey(key)) return;
    this._fleetHidden.add(key);
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
    try {
      await this.fleetStopSession(f.deviceId, f.sessionId);
      this.showToast?.('Remote session stopped', 'success');
    } catch {
      this.showToast?.('Failed to stop remote session', 'error');
    }
  },

  /**
   * Build the markup for one remote tab. Mirrors the native `.session-tab`
   * structure (status dot + mode badge + name) but trimmed: no tab-number
   * (Alt+N maps to local sessionOrder only), no gear/detach/task/subagent
   * badges (Claude-specific). Every remote-origin string is escaped.
   */
  _fleetTabHtml(key, tab) {
    const isActive = key === this.activeSessionId;
    const status = tab.status || 'idle';
    // Offline device → grey/dim dot (reuse the native `.tab-status.ended` look);
    // online → the session's own idle/busy/error color. All existing CSS vars.
    const dotClass = tab.online === false ? 'ended' : status;
    const mode = tab.mode || 'claude';
    const modeBadge =
      mode === 'shell'
        ? '<span class="tab-mode shell" aria-hidden="true">sh</span>'
        : mode === 'opencode'
          ? '<span class="tab-mode opencode" aria-hidden="true">oc</span>'
          : mode === 'codex'
            ? '<span class="tab-mode codex" aria-hidden="true">cx</span>'
            : mode === 'gemini'
              ? '<span class="tab-mode gemini" aria-hidden="true">gm</span>'
              : '';
    const keyJson = escapeHtml(JSON.stringify(key));
    const titleAttr = tab.workingDir ? `${tab.deviceName} · ${tab.workingDir}` : tab.deviceName || '';
    return `<div class="session-tab fleet-tab ${isActive ? 'active' : ''}${tab.online === false ? ' fleet-offline' : ''}" data-id="${escapeHtml(key)}" data-fleet="1" onclick="app.handleSessionTabClick(event, ${keyJson})" tabindex="0" role="tab" aria-selected="${isActive ? 'true' : 'false'}" aria-label="${escapeHtml(tab.title || key)} remote session" title="${escapeHtml(titleAttr)}">
        <span class="tab-status ${dotClass}" aria-hidden="true"></span>
        <span class="tab-info">
          <span class="tab-name-row">
            <span class="tab-fleet-dev" aria-hidden="true">\u{1F5A5}</span>
            ${modeBadge}
            <span class="tab-name"><span class="tab-prefix">${escapeHtml(tab.deviceName || '')}</span><span class="tab-suffix"> / ${escapeHtml(tab.sessionLabel || '')}</span></span>
          </span>
        </span>
        <span class="tab-close" onclick="event.stopPropagation(); app.requestCloseSession(${keyJson})" title="Close tab (session keeps running)" aria-label="Close remote tab" tabindex="0">&times;</span>
      </div>`;
  },
});
