/**
 * @fileoverview Fleet device management panel (Rev 3 融入式, Task 19).
 *
 * A side panel in the SAME interaction language as the existing panels-ui
 * surfaces (subagents / file-browser): a fixed docked panel toggled open/closed
 * via a `.visible` class, opened from a header button with an online-device
 * count badge. It is NOT a second dashboard — remote sessions still live as
 * native tabs (fleet-tabs.js); this panel only manages devices, pairing, and
 * remote session lifecycle.
 *
 * Contents (spec §6.2):
 *   - Device list: status dot / platform / hostname / active-session count /
 *     `⚠ 无 tmux` capability tag. Clicking a device only updates in-panel
 *     selection state (NEVER navigates); selecting a remote device expands its
 *     remote sessions with a per-session stop action.
 *   - External sessions (Rev5 §13.3, Task 29): a "发现的外部会话" section below
 *     the device list lists the SELECTED device's discovered foreign-tmux
 *     candidates (`GET /api/fleet/external-sessions`, fetched once on panel
 *     open + kept current by the `fleet:external-sessions-updated` SSE delta —
 *     see `_refreshFleetExternalSessions`/`_onFleetExternalSessionsUpdated`).
 *     "收编为 Tab" POSTs `.../adopt-session`; a candidate whose tmux session was
 *     already adopted (matched against `state.sessions` by the `tmux:<name>`
 *     convention + workingDir — the scanner keeps reporting the foreign tmux
 *     session forever, it never leaves the foreign server) renders as 已收编
 *     with the button disabled instead of disappearing.
 *   - Pairing: mint a one-time code → shows code + expiry countdown + a copyable
 *     `codeman node join …` command (copied via app._copyText, the codebase's
 *     clipboard helper, with a toast).
 *   - Remote session create form: device select (defaults to the in-panel
 *     selection; offline devices disabled), required workingDir, a mode
 *     segmented control (claude/codex/shell/gemini/opencode) → POST via
 *     fleet-api, then refreshFleetState + toast.
 *   - workingDir picker (Task 25, spec §12.5): the input carries custom recent
 *     candidates — the selected device's live session workingDirs ∪
 *     its resume-candidate workingDirs (fetched lazily, cached per device for
 *     the panel's lifetime), deduped and ranked by most-recent activity, capped
 *     at 15. A "浏览…" button beside it opens `#fleetDirModal`, an app-modal
 *     breadcrumb+list directory browser driven by `fleetListDirs()`
 *     (GET .../dirs) that works identically for the local device and remotes.
 *     Manual typing into the input is always allowed either way.
 *
 * Hard rules honored here:
 *   - NO native confirm/alert/prompt — the stop-session confirmation uses the
 *     app's own `#fleetStopModal` modal, the dir browser is `#fleetDirModal`;
 *     everything else uses showToast.
 *   - Every device/session-sourced string flows through escapeHtml (device
 *     names/hostnames come from remote machines → untrusted); every
 *     server-sourced directory name/path (dir browser + custom candidates)
 *     likewise flows through escapeHtml — a remote node's filesystem is
 *     equally untrusted input.
 *   - Only existing CSS variables (follows data-skin).
 *
 * SSE refresh: fleet:* events map to refreshFleetState (app.js), which caches
 * `this._fleetState`, updates the header badge, and re-renders THIS panel while
 * it is open (hooks added to refreshFleetState in fleet-tabs.js).
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js (CodemanApp, this.$, this._copyText, showToast),
 *   fleet-api.js (fleetCreatePairingCode/fleetCreateSession/fleetStopSession/
 *   fleetResumeCandidates/fleetListDirs/fleetExternalSessions/fleetAdoptSession),
 *   fleet-tabs.js (refreshFleetState/stopFleetSession/isFleetKey),
 *   constants.js (escapeHtml)
 * @loadorder after fleet-tabs.js
 */

const FLEET_MODES = ['claude', 'codex', 'shell', 'gemini', 'opencode'];

Object.assign(CodemanApp.prototype, {
  /**
   * Toggle the device panel. Lazily seeds the create-form mode default and, on
   * open, kicks a fresh fleet refresh (which re-renders the panel via the
   * refreshFleetState hook) so the panel is never stale on first open.
   */
  toggleFleetPanel() {
    const panel = this.$('fleetPanel');
    if (!panel) return;
    const willOpen = !panel.classList.contains('visible');
    panel.classList.toggle('visible', willOpen);
    this.fleetPanelVisible = willOpen;
    if (willOpen) {
      if (!this._fleetCreateMode) this._fleetCreateMode = 'claude';
      // Render immediately from the last snapshot, then refresh for freshness.
      this.renderFleetPanel();
      this.refreshFleetState();
      this._refreshFleetExternalSessions();
    }
  },

  /** Close the device panel (matches file-browser/subagents close wiring). */
  closeFleetPanel() {
    const panel = this.$('fleetPanel');
    if (panel) panel.classList.remove('visible');
    this.fleetPanelVisible = false;
  },

  /**
   * Update the header online-device-count badge. Called on EVERY fleet refresh
   * (regardless of panel open state) so the badge stays live like the subagent
   * count badge. Empty (hidden) when zero online devices.
   */
  _updateFleetBadge() {
    const badge = this.$('fleetDevicesBadge');
    if (!badge) return;
    const devices = (this._fleetState && this._fleetState.devices) || [];
    const online = devices.filter((d) => d.status === 'online').length;
    if (online > 0) {
      badge.textContent = String(online);
      badge.style.display = '';
    } else {
      badge.textContent = '';
      badge.style.display = 'none';
    }
  },

  /** Re-render the panel body only when it is open (SSE-driven refresh path). */
  _renderFleetPanelIfOpen() {
    if (this.fleetPanelVisible) this.renderFleetPanel();
  },

  /**
   * Full panel render from the cached `this._fleetState`. Pure DOM writes into
   * the static panel containers; the panel shell lives in index.html. Preserves
   * in-panel selection and the create-form inputs across re-renders.
   */
  renderFleetPanel() {
    const listEl = this.$('fleetDeviceList');
    if (!listEl) return;
    const state = this._fleetState || { devices: [], sessions: [] };
    const devices = state.devices || [];
    const sessions = state.sessions || [];

    // Keep the in-panel selection valid; default to the first online device.
    if (!this._fleetSelectedDeviceId || !devices.some((d) => d.id === this._fleetSelectedDeviceId)) {
      const firstOnline = devices.find((d) => d.status === 'online') || devices[0];
      this._fleetSelectedDeviceId = firstOnline ? firstOnline.id : null;
    }

    if (devices.length === 0) {
      listEl.innerHTML = '<div class="fleet-empty">暂无设备。生成配对码以加入新设备。</div>';
    } else {
      listEl.innerHTML = devices.map((d) => this._fleetDeviceHtml(d, sessions)).join('');
    }

    this._renderFleetDeviceSelect(devices);
    this._renderFleetModeSeg();
    const createSel = this.$('fleetCreateDevice');
    this._refreshFleetDirCandidates(createSel && createSel.value);
    // Cheap re-render from the already-fetched candidate cache — picks up both
    // a device-selection change and any `adopted` flag that just landed on
    // `state.sessions` (e.g. right after a successful adopt POST).
    this._renderFleetExternalSessions();
  },

  /** One device row (+ its remote sessions when selected). All strings escaped. */
  _fleetDeviceHtml(device, sessions) {
    const online = device.status === 'online';
    const selected = device.id === this._fleetSelectedDeviceId;
    const isLocal = device.id === 'local';
    const name = escapeHtml(device.name || device.hostname || device.id.slice(0, 8));
    const platform = escapeHtml(device.platform || '');
    const count = Number(device.activeSessionCount || 0);
    const noTmux = device.capabilities && device.capabilities.tmux === false;
    const capTag = noTmux
      ? '<span class="fleet-cap-warn" title="This device cannot run tmux sessions">⚠ 无 tmux</span>'
      : '';

    // Remote sessions (with stop) only for the SELECTED, non-local device — local
    // sessions are already native tabs with their own close/kill flow.
    let sessionsHtml = '';
    if (selected && !isLocal) {
      const own = sessions.filter((s) => s.deviceId === device.id);
      sessionsHtml =
        own.length === 0
          ? '<div class="fleet-session-empty">无活动会话</div>'
          : own.map((s) => this._fleetSessionHtml(device, s)).join('');
      sessionsHtml = `<div class="fleet-session-list">${sessionsHtml}</div>`;
    }

    return `<div class="fleet-device ${selected ? 'selected' : ''} ${online ? '' : 'offline'}" role="button" tabindex="0" aria-pressed="${selected ? 'true' : 'false'}" onclick="app.selectFleetDevice(${escapeHtml(JSON.stringify(device.id))})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();app.selectFleetDevice(${escapeHtml(JSON.stringify(device.id))})}">
        <span class="fleet-device-dot ${online ? 'online' : 'offline'}" aria-hidden="true"></span>
        <div class="fleet-device-main">
          <div class="fleet-device-name">${name}</div>
          <div class="fleet-device-meta">
            ${platform ? `<span class="fleet-device-platform">${platform}</span>` : ''}
            <span class="fleet-device-sessions">${count} 会话</span>
            ${capTag}
          </div>
        </div>
      </div>${sessionsHtml}`;
  },

  /**
   * One remote session row with a stop action. All strings escaped. Adopted
   * (foreign-tmux) sessions get a 🔗 marker and a relabeled/repurposed action
   * button — Codeman never owns their lifecycle, so "停止" (which reads as
   * destructive) would be misleading; the button becomes "移除" and its
   * confirm-modal copy is swapped by `requestStopFleetSession` accordingly.
   */
  _fleetSessionHtml(device, session) {
    const key = `${session.deviceId}:${session.id}`;
    const status = escapeHtml(session.status || 'idle');
    const mode = session.mode || 'claude';
    const label = session.name || this._fleetBasename(session.workingDir) || session.id.slice(0, 8);
    const modeBadge = mode !== 'claude' ? `<span class="fleet-session-mode">${escapeHtml(mode)}</span>` : '';
    const adopted = !!session.adopted;
    const adoptedBadge = adopted
      ? '<span class="tab-adopted-badge" title="收编的外部 tmux 会话 · Adopted external tmux session" aria-hidden="true">\u{1F517}</span>'
      : '';
    const keyJson = escapeHtml(JSON.stringify(key));
    const labelJson = escapeHtml(JSON.stringify(`${device.name || device.hostname || ''} / ${label}`));
    const stopLabel = adopted ? '移除' : '停止';
    const stopTitle = adopted ? '从 Codeman 移除(不会关闭该 tmux 会话)' : '停止远程会话';
    const stopAria = adopted ? 'Remove adopted session (tmux keeps running)' : 'Stop remote session';
    return `<div class="fleet-session">
        <span class="fleet-session-dot ${status}" aria-hidden="true"></span>
        <span class="fleet-session-label fleet-session-open" role="button" tabindex="0" title="${escapeHtml(session.workingDir || '')}" aria-label="打开会话 · Open session" onclick="app.openFleetSessionTab(${keyJson})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();app.openFleetSessionTab(${keyJson})}">${modeBadge}${adoptedBadge}${escapeHtml(label)}</span>
        <button type="button" class="fleet-session-stop" onclick="event.stopPropagation(); app.requestStopFleetSession(${keyJson}, ${labelJson}, ${adopted})" title="${stopTitle}" aria-label="${stopAria}">${stopLabel}</button>
      </div>`;
  },

  /** Basename without importing node path (device workingDir is a string). */
  _fleetBasename(p) {
    if (!p || typeof p !== 'string') return '';
    const parts = p.split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
  },

  /**
   * Display name for a device id from the cached fleet snapshot — the real
   * device name (local = os.hostname()), never "本机". Falls back to the raw id.
   */
  _fleetDeviceDisplayName(deviceId) {
    const devices = (this._fleetState && this._fleetState.devices) || [];
    const d = devices.find((x) => x.id === deviceId);
    return (d && (d.name || d.hostname || String(d.id).slice(0, 8))) || String(deviceId || '');
  },

  // ─── External session discovery + adoption (Rev5 §13.3, Task 29) ───────────
  //
  // `this._fleetExternalSessionsByDevice` — Record<deviceId, ExternalSessionCandidate[]>,
  // fetched in one shot on panel open (fetches EVERY device, not just the
  // selected one — the `/api/fleet/external-sessions` response already covers
  // the whole fleet) and kept current thereafter by the `fleet:external-
  // sessions-updated` SSE delta (`_onFleetExternalSessionsUpdated`, wired in
  // app.js's `_SSE_HANDLER_MAP`), which merges straight into the cache with NO
  // refetch. The section only ever displays the currently-SELECTED device's
  // slice (spec §13.3); `renderFleetPanel`/`selectFleetDevice` re-render it on
  // every device-selection change from the cache alone.

  /**
   * Fetch + cache the fleet-wide candidate map, then render. Called on panel
   * open. A failure leaves whatever was cached (rendered as-is, or the empty
   * section on first load) — non-fatal, matches `_refreshFleetDirCandidates`'s
   * silent-fail convention.
   */
  async _refreshFleetExternalSessions() {
    let byDevice = null;
    try {
      byDevice = await this.fleetExternalSessions();
    } catch {
      /* keep whatever was cached */
    }
    if (byDevice && typeof byDevice === 'object') this._fleetExternalSessionsByDevice = byDevice;
    this._renderFleetExternalSessions();
  },

  /**
   * SSE `fleet:external-sessions-updated` handler (payload `{deviceId,
   * candidates}`), wired in app.js's `_SSE_HANDLER_MAP`. Merges the single
   * device's slice directly into the cache — no refetch, this delta already
   * carries the full current list for that device — then re-renders only when
   * the panel is open (cheap either way, but the panel may not exist yet).
   */
  _onFleetExternalSessionsUpdated(data) {
    if (!data || !data.deviceId) return;
    if (!this._fleetExternalSessionsByDevice) this._fleetExternalSessionsByDevice = {};
    this._fleetExternalSessionsByDevice[data.deviceId] = Array.isArray(data.candidates) ? data.candidates : [];
    if (this.fleetPanelVisible) this._renderFleetExternalSessions();
  },

  /**
   * Render the "发现的外部会话" section for the currently-selected device. Hidden
   * entirely when no device is selected/known (e.g. panel opened with an empty
   * fleet). All candidate strings (tmux session name, workingDir) are
   * untrusted (foreign/remote-machine-controlled) → escaped in
   * `_fleetExternalSessionHtml`.
   */
  _renderFleetExternalSessions() {
    const section = this.$('fleetExternalSessions');
    const listEl = this.$('fleetExternalSessionList');
    if (!section || !listEl) return;
    const deviceId = this._fleetSelectedDeviceId;
    const state = this._fleetState || { devices: [] };
    const deviceExists = !!deviceId && (state.devices || []).some((d) => d.id === deviceId);
    if (!deviceExists) {
      section.style.display = 'none';
      listEl.innerHTML = '';
      return;
    }
    section.style.display = '';
    const byDevice = this._fleetExternalSessionsByDevice || {};
    const candidates = byDevice[deviceId] || [];
    if (candidates.length === 0) {
      listEl.innerHTML = '<div class="fleet-session-empty">未发现外部会话</div>';
      return;
    }
    const adoptedKeys = this._fleetAdoptedCandidateKeys(deviceId);
    listEl.innerHTML = candidates.map((c) => this._fleetExternalSessionHtml(deviceId, c, adoptedKeys)).join('');
  },

  /**
   * Set of `${tmuxSession} ${workingDir}` keys already adopted on
   * `deviceId`, derived from `state.sessions` (FleetSessionSummary carries
   * `.adopted` but NOT the original candidate's `socket` — `buildAdoptedSession`
   * (adopt-session.ts) names the session `tmux:<tmuxSession>` and copies
   * `workingDir` verbatim from the candidate, so that pair is a reliable
   * reconstruction of the adoption's source candidate). Adopting a candidate
   * does not remove the foreign tmux session from the scanner's view (it never
   * left the foreign server), so the candidate list keeps reporting it
   * forever — this lets a matching row render as 已收编/disabled instead of
   * silently vanishing or offering to re-adopt.
   */
  _fleetAdoptedCandidateKeys(deviceId) {
    const state = this._fleetState || { sessions: [] };
    const keys = new Set();
    for (const s of state.sessions || []) {
      if (s.deviceId !== deviceId || !s.adopted) continue;
      const m = /^tmux:(.*)$/.exec(s.name || '');
      if (!m) continue;
      keys.add(`${m[1]} ${s.workingDir || ''}`);
    }
    return keys;
  },

  /** One discovered-candidate row. All remote-origin strings escaped. */
  _fleetExternalSessionHtml(deviceId, candidate, adoptedKeys) {
    const mode = candidate.mode || 'claude';
    const modeBadge = `<span class="fleet-session-mode">${escapeHtml(mode)}</span>`;
    const tmuxSession = candidate.tmuxSession || '';
    const workingDir = candidate.workingDir || '';
    const isAdopted = adoptedKeys.has(`${tmuxSession} ${workingDir}`);
    const deviceJson = escapeHtml(JSON.stringify(deviceId));
    const socketJson = escapeHtml(JSON.stringify(candidate.socket || ''));
    const tmuxJson = escapeHtml(JSON.stringify(tmuxSession));
    const btn = isAdopted
      ? '<button type="button" class="fleet-adopt-btn" disabled>已收编</button>'
      : `<button type="button" class="fleet-adopt-btn" onclick="app.adoptFleetExternalSession(event.currentTarget, ${deviceJson}, ${socketJson}, ${tmuxJson})">收编为 Tab</button>`;
    return `<div class="fleet-external-session${isAdopted ? ' adopted' : ''}">
        <span class="fleet-external-session-main" title="${escapeHtml(workingDir)}">
          ${modeBadge}<span class="fleet-external-session-name">tmux:${escapeHtml(tmuxSession)}</span>
          <span class="fleet-external-session-dir">${escapeHtml(this._fleetTruncatePath(workingDir))}</span>
        </span>
        ${btn}
      </div>`;
  },

  /** Truncate a long path for display (tail kept — most identifying part); the full path stays in the row's title. */
  _fleetTruncatePath(p) {
    if (!p || typeof p !== 'string') return '';
    const max = 40;
    if (p.length <= max) return p;
    return `…${p.slice(-(max - 1))}`;
  },

  /**
   * "收编为 Tab" click. Busy-guards the CLICKED button only (candidate rows are
   * independent, so a global busy flag would needlessly block unrelated rows).
   * On success, the adopted session already landed in the central cache
   * synchronously (central-controller.ts's adoptSession upserts from the ack
   * before resolving) — `refreshFleetState()` picks it up immediately, and the
   * `renderFleetPanel`→`_renderFleetExternalSessions` chain then grays this row
   * out via `_fleetAdoptedCandidateKeys` without waiting for the next scanner
   * tick. 404 = candidate vanished between render and click (re-fetch clears
   * it); 409 = device went offline (refreshFleetState reflects that too).
   */
  async adoptFleetExternalSession(btn, deviceId, socket, tmuxSession) {
    if (btn) btn.disabled = true;
    let res = null;
    try {
      res = await this.fleetAdoptSession(deviceId, { socket, tmuxSession });
    } catch {
      /* handled below */
    }
    if (res && res.ok) {
      this.showToast('已收编为 Tab', 'success');
      this.refreshFleetState();
      return;
    }
    if (btn) btn.disabled = false;
    if (res && res.status === 404) {
      this.showToast('会话已消失', 'error');
      this._refreshFleetExternalSessions();
    } else if (res && res.status === 409) {
      this.showToast('设备离线', 'error');
      this.refreshFleetState();
    } else {
      this.showToast('收编失败', 'error');
    }
  },

  /**
   * (Re)populate the create-form device <select>. Offline devices are disabled.
   * Preserves the current selection, defaulting to the in-panel selected device.
   */
  _renderFleetDeviceSelect(devices) {
    const sel = this.$('fleetCreateDevice');
    if (!sel) return;
    const prev = sel.value || this._fleetSelectedDeviceId || '';
    sel.innerHTML = (devices || [])
      .map((d) => {
        const online = d.status === 'online';
        const name = escapeHtml(d.name || d.hostname || d.id.slice(0, 8));
        const suffix = online ? '' : ' — offline';
        return `<option value="${escapeHtml(d.id)}" ${online ? '' : 'disabled'}>${name}${suffix}</option>`;
      })
      .join('');
    // Restore selection: prefer prior value, then in-panel selection, then first online.
    const candidates = [prev, this._fleetSelectedDeviceId];
    for (const c of candidates) {
      if (c && devices.some((d) => d.id === c && d.status === 'online')) {
        sel.value = c;
        return;
      }
    }
    const firstOnline = (devices || []).find((d) => d.status === 'online');
    if (firstOnline) sel.value = firstOnline.id;
  },

  /** Reflect the segmented-control active state from `this._fleetCreateMode`. */
  _renderFleetModeSeg() {
    const seg = this.$('fleetCreateMode');
    if (!seg) return;
    const mode = this._fleetCreateMode || 'claude';
    seg.querySelectorAll('.fleet-mode-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    });
  },

  /**
   * In-panel device selection ONLY (spec §6.2: 点设备只更新面板内选中态,绝不跳转).
   * Never touches activeSessionId / selectSession.
   */
  selectFleetDevice(deviceId) {
    this._fleetSelectedDeviceId = deviceId;
    // Default the create-form device to the newly-selected one when it's online.
    const sel = this.$('fleetCreateDevice');
    const state = this._fleetState || { devices: [] };
    const dev = (state.devices || []).find((d) => d.id === deviceId);
    if (sel && dev && dev.status === 'online') sel.value = deviceId;
    this.renderFleetPanel();
  },

  /** Segmented mode control click handler. */
  setFleetCreateMode(mode) {
    if (!FLEET_MODES.includes(mode)) return;
    this._fleetCreateMode = mode;
    this._renderFleetModeSeg();
  },

  // ─── Pairing ──────────────────────────────────────────────────────────────

  /** Mint a one-time pairing code, then show it + a live expiry countdown. */
  async generateFleetPairingCode() {
    const btn = this.$('fleetPairBtn');
    if (btn) btn.disabled = true;
    let pairing = null;
    try {
      pairing = await this.fleetCreatePairingCode();
    } catch {
      /* handled below */
    }
    if (btn) btn.disabled = false;
    if (!pairing || !pairing.code) {
      this.showToast('生成配对码失败', 'error');
      return;
    }
    this._fleetPairing = pairing;
    this._renderFleetPairing();
    this.showToast('配对码已生成', 'success');
  },

  /** Render the pairing block and (re)start the 1s expiry countdown timer. */
  _renderFleetPairing() {
    const wrap = this.$('fleetPairing');
    const codeEl = this.$('fleetPairingCode');
    const cmdEl = this.$('fleetJoinCmd');
    if (!wrap || !codeEl || !cmdEl) return;
    const pairing = this._fleetPairing;
    if (!pairing) {
      wrap.style.display = 'none';
      return;
    }
    wrap.style.display = '';
    codeEl.textContent = pairing.code;
    cmdEl.textContent = pairing.joinCommand || '';
    this._tickFleetPairingExpiry();
    if (this._fleetPairingTimer) clearInterval(this._fleetPairingTimer);
    this._fleetPairingTimer = setInterval(() => this._tickFleetPairingExpiry(), 1000);
  },

  /** One countdown tick; clears itself + the code display when expired. */
  _tickFleetPairingExpiry() {
    const expiryEl = this.$('fleetPairingExpiry');
    const pairing = this._fleetPairing;
    if (!expiryEl) return;
    if (!pairing) {
      expiryEl.textContent = '';
      return;
    }
    const remainMs = (pairing.expiresAt || 0) - Date.now();
    if (remainMs <= 0) {
      expiryEl.textContent = '已过期';
      if (this._fleetPairingTimer) {
        clearInterval(this._fleetPairingTimer);
        this._fleetPairingTimer = null;
      }
      this._fleetPairing = null;
      const codeEl = this.$('fleetPairingCode');
      const cmdEl = this.$('fleetJoinCmd');
      if (codeEl) codeEl.textContent = '——';
      if (cmdEl) cmdEl.textContent = '';
      return;
    }
    const secs = Math.ceil(remainMs / 1000);
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    expiryEl.textContent = `${m}:${String(s).padStart(2, '0')} 后过期`;
  },

  /** Copy the join command via the app clipboard helper (with toast feedback). */
  async copyFleetJoinCommand() {
    const cmd = this._fleetPairing && this._fleetPairing.joinCommand;
    if (!cmd) {
      this.showToast('没有可复制的配对命令', 'warning');
      return;
    }
    const ok = await this._copyText(cmd);
    this.showToast(ok ? '配对命令已复制' : '复制失败', ok ? 'success' : 'error');
  },

  // ─── workingDir smart candidates (Task 25) ──────────────────────────────────

  /** Create-form device <select> onchange — refresh the workingDir suggestions. */
  onFleetCreateDeviceChange() {
    const sel = this.$('fleetCreateDevice');
    this._refreshFleetDirCandidates(sel && sel.value);
  },

  /**
   * (Re)build the workingDir candidate list for `deviceId`: that
   * device's live session workingDirs (fresh off `this._fleetState` every
   * call) ∪ its resume-candidate workingDirs (fetched once per device and
   * cached in `this._fleetDirCandCache` for the panel's lifetime — switching
   * devices back and forth doesn't refetch). Silent-fails to an empty resume
   * set on any error (offline/timeout/network); the session-derived half of
   * the list is unaffected either way. Manual typing into the input still
   * works regardless of candidate availability.
   */
  async _refreshFleetDirCandidates(deviceId, listElId = 'fleetDirCandidates') {
    this._renderFleetDirCandidates(deviceId, listElId);
    if (!deviceId) return;
    if (!this._fleetDirCandCache) this._fleetDirCandCache = new Map();
    if (this._fleetDirCandCache.has(deviceId)) return; // cached (or an in-flight fetch already placeheld below)
    this._fleetDirCandCache.set(deviceId, []); // placeholder: guards against duplicate concurrent fetches
    let candidates = null;
    try {
      candidates = await this.fleetResumeCandidates(deviceId);
    } catch {
      /* silent-fail to empty */
    }
    this._fleetDirCandCache.set(deviceId, Array.isArray(candidates) ? candidates : []);
    // Re-paint the target list once the resume fetch resolves — but only if it's
    // still the relevant device (create-form: the <select> hasn't moved on;
    // quick-start chooser: still choosing for this device), so a mid-fetch device
    // switch can't paint stale candidates into a chooser the user has moved past.
    if (listElId === 'fleetDirCandidates') {
      const sel = this.$('fleetCreateDevice');
      if (sel && sel.value === deviceId) this._renderFleetDirCandidates(deviceId, listElId);
    } else if (this._quickStartDirDeviceId === deviceId) {
      this._renderFleetDirCandidates(deviceId, listElId);
    }
  },

  /**
   * Merge the two candidate sources, dedup by workingDir keeping the most
   * recent timestamp, sort most-recent-first, cap at 15, and paint custom
   * candidate buttons. All values escaped (remote workingDirs are untrusted).
   */
  _renderFleetDirCandidates(deviceId, listElId = 'fleetDirCandidates') {
    const list = this.$(listElId);
    if (!list) return;
    if (!deviceId) {
      list.innerHTML = '';
      return;
    }
    const state = this._fleetState || { sessions: [] };
    const sessionDirs = (state.sessions || [])
      .filter((s) => s.deviceId === deviceId && s.workingDir)
      .map((s) => ({ dir: s.workingDir, at: s.lastActivityAt || 0 }));
    const resumeCands = (this._fleetDirCandCache && this._fleetDirCandCache.get(deviceId)) || [];
    const resumeDirs = resumeCands
      .filter((c) => c && c.workingDir)
      .map((c) => ({ dir: c.workingDir, at: c.updatedAt || 0 }));

    const merged = new Map(); // workingDir -> most-recent `at` seen for it
    for (const { dir, at } of [...sessionDirs, ...resumeDirs]) {
      const prev = merged.get(dir);
      if (prev === undefined || at > prev) merged.set(dir, at);
    }
    const ranked = [...merged.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([dir]) => dir);

    const inputId = listElId === 'quickStartDirCandidates' ? 'quickStartDirInput' : 'fleetCreateDir';
    list.innerHTML = ranked
      .map((dir) => {
        const dirJson = escapeHtml(JSON.stringify(dir));
        const short = this._shortenHomePath ? this._shortenHomePath(dir) : dir;
        return `<button type="button" class="fleet-dir-candidate" title="${escapeHtml(dir)}" onclick="app.selectFleetDirCandidate('${inputId}', ${dirJson})">${escapeHtml(short)}</button>`;
      })
      .join('');
  },

  selectFleetDirCandidate(inputId, dir) {
    const input = this.$(inputId);
    if (!input || typeof dir !== 'string') return;
    input.value = dir;
    try {
      input.focus();
    } catch {
      /* best-effort */
    }
  },

  // ─── Remote session create ──────────────────────────────────────────────────

  /** Validate + POST a remote session create, then refresh + toast. */
  async submitFleetCreateSession() {
    const sel = this.$('fleetCreateDevice');
    const dirEl = this.$('fleetCreateDir');
    const deviceId = sel && sel.value;
    const workingDir = dirEl && dirEl.value.trim();
    const mode = this._fleetCreateMode || 'claude';
    if (!deviceId) {
      this.showToast('请选择一个在线设备', 'warning');
      return;
    }
    if (!workingDir) {
      this.showToast('工作目录为必填项', 'warning');
      if (dirEl) dirEl.focus();
      return;
    }
    const btn = this.$('fleetCreateBtn');
    if (btn) btn.disabled = true;
    let created = null;
    try {
      created = await this.fleetCreateSession(deviceId, { workingDir, mode });
    } catch {
      /* handled below */
    }
    if (btn) btn.disabled = false;
    if (!created || !created.id) {
      this.showToast('远程会话创建失败', 'error');
      return;
    }
    if (dirEl) dirEl.value = '';
    const key = `${deviceId}:${created.id}`;
    // A brand-new session id can't collide with a stale hidden entry, but drop
    // it defensively so nothing suppresses the tab we're about to open.
    if (this._fleetHidden && this._fleetHidden.has(key)) {
      this._fleetHidden.delete(key);
      this._saveFleetHiddenKeys?.();
    }
    const deviceName = this._fleetDeviceDisplayName(deviceId);
    // Mirror _quickStartRemote: refresh so the new key lands in the registry,
    // then open + select it (same experience as a local create). deviceName is
    // rendered by showToast via textContent, which auto-escapes — passing the
    // raw name (NOT escapeHtml) avoids double-escaping a name with special chars.
    await this.refreshFleetState();
    if (this.isFleetKey(key)) {
      this.selectSession(key, { forceReload: true });
      this.showToast(`已在 ${deviceName} 创建并打开`, 'success');
    } else {
      this.showToast(`已在 ${deviceName} 创建`, 'success');
    }
  },

  // ─── Stop remote session (modal confirm — NO native confirm) ────────────────

  /**
   * Arm the stop-confirm modal for a remote session key. `adopted` swaps the
   * modal's warning copy + danger-button text: an adopted (foreign-tmux)
   * session is detach-only server-side regardless of which button is pressed
   * (Session.stop() never kills a `_externalHost` session's mux), so the
   * default "will terminate, irreversible" wording would be actively false —
   * it must read as a safe removal instead (spec §13.2/§13.3 safety rail).
   */
  requestStopFleetSession(key, label, adopted) {
    this._fleetStopPending = { key, label: label || key, adopted: !!adopted };
    const nameEl = this.$('fleetStopName');
    if (nameEl) nameEl.textContent = this._fleetStopPending.label;
    const warnEl = this.$('fleetStopWarn');
    if (warnEl) {
      warnEl.textContent = this._fleetStopPending.adopted
        ? '仅从 Codeman 移除,不会关闭你的 tmux 会话。'
        : '将在远端设备上终止该会话,操作不可撤销。';
    }
    const titleEl = this.$('fleetStopTitle');
    if (titleEl) titleEl.textContent = this._fleetStopPending.adopted ? '移除收编会话' : '停止远程会话';
    const titleEl2 = this.$('fleetStopConfirmTitle');
    if (titleEl2) titleEl2.textContent = this._fleetStopPending.adopted ? '移除会话' : '停止会话';
    const descEl = this.$('fleetStopConfirmDesc');
    if (descEl) {
      descEl.textContent = this._fleetStopPending.adopted
        ? 'Detach only — the tmux session keeps running'
        : 'Terminate the remote session';
    }
    const modal = this.$('fleetStopModal');
    if (modal) modal.classList.add('active');
  },

  /** Dismiss the stop-confirm modal without acting. */
  cancelStopFleetSession() {
    this._fleetStopPending = null;
    const modal = this.$('fleetStopModal');
    if (modal) modal.classList.remove('active');
  },

  /**
   * Confirmed stop. Prefers the Task 18 `stopFleetSession(key)` helper when the
   * key is a live remote tab; otherwise stops directly by device+session (the
   * device panel is authoritative — a session may have no visible tab, e.g. it
   * was locally hidden). Refreshes fleet state afterward.
   */
  async confirmStopFleetSession() {
    const pending = this._fleetStopPending;
    this.cancelStopFleetSession();
    if (!pending || !pending.key) return;
    if (this.isFleetKey && this.isFleetKey(pending.key)) {
      await this.stopFleetSession(pending.key);
    } else {
      const [deviceId, sessionId] = String(pending.key).split(':');
      try {
        await this.fleetStopSession(deviceId, sessionId);
        const msg = pending.adopted ? '已从 Codeman 移除(tmux 会话未受影响)' : 'Remote session stopped';
        this.showToast(msg, 'success');
      } catch {
        const msg = pending.adopted ? '移除失败' : 'Failed to stop remote session';
        this.showToast(msg, 'error');
      }
    }
    this.refreshFleetState();
  },

  // ─── Directory browser modal (Task 25, spec §12.5) ──────────────────────────
  //
  // Navigation state lives on `this._fleetDirBrowser` while `#fleetDirModal` is
  // open: `{ deviceId, relPath, absPath, dirs, loading, error, reqId }`.
  // `relPath` is ALWAYS home-relative (never absolute, never containing a
  // leading slash) — every request to fleetListDirs() sends a relative
  // subpath, which the node resolves under ITS OWN $HOME (dir-listing.ts).
  // This sidesteps having to know or construct the target device's absolute
  // home path / OS-specific separators in the browser; only the display value
  // filled into the form on "选择此目录" uses the server-resolved absolute
  // `path` verbatim. `reqId` guards against a stale response (from a
  // superseded navigation, or after the modal was closed) clobbering newer
  // state.

  /** "浏览…" button — open the modal for the create-form's currently-selected device. */
  openFleetDirBrowser(opts) {
    // Two call shapes: (1) no args from the panel create-form "浏览…" button —
    // browse the create-form's selected device and fill #fleetCreateDir on pick;
    // (2) { deviceId, onSelect } from the quick-start chooser — browse an
    // explicit device (incl. 'local') and hand the picked absolute path to a
    // callback instead. The onclick attribute calls this with NO args, so the
    // create-form path is byte-identical.
    let deviceId;
    let onSelect = null;
    if (opts && typeof opts === 'object' && opts.deviceId) {
      deviceId = opts.deviceId;
      onSelect = typeof opts.onSelect === 'function' ? opts.onSelect : null;
    } else {
      const sel = this.$('fleetCreateDevice');
      deviceId = sel && sel.value;
    }
    if (!deviceId) {
      this.showToast('请先选择一个在线设备', 'warning');
      return;
    }
    this._fleetDirBrowser = {
      deviceId,
      relPath: '',
      absPath: '',
      dirs: [],
      loading: false,
      error: null,
      reqId: 0,
      onSelect,
    };
    const modal = this.$('fleetDirModal');
    if (modal) modal.classList.add('active');
    this._fleetDirEscHandler = (ev) => {
      if (ev.key === 'Escape') this.closeFleetDirBrowser();
    };
    document.addEventListener('keydown', this._fleetDirEscHandler);
    this._loadFleetDir('');
  },

  /** Close the browser modal without applying a selection. */
  closeFleetDirBrowser() {
    const modal = this.$('fleetDirModal');
    if (modal) modal.classList.remove('active');
    this._fleetDirBrowser = null;
    if (this._fleetDirEscHandler) {
      document.removeEventListener('keydown', this._fleetDirEscHandler);
      this._fleetDirEscHandler = null;
    }
  },

  /**
   * Fetch one level (`relPath`, home-relative) for the browser's device and
   * render it. On failure the PREVIOUSLY loaded breadcrumb/list is kept intact
   * (only an inline error + toast appear) so a transient blip doesn't strand
   * the user at a blank screen.
   */
  async _loadFleetDir(relPath) {
    const browser = this._fleetDirBrowser;
    if (!browser) return;
    const reqId = (browser.reqId += 1);
    browser.loading = true;
    browser.error = null;
    this._renderFleetDirBrowser();
    let result = null;
    try {
      result = await this.fleetListDirs(browser.deviceId, relPath || undefined);
    } catch {
      /* handled below */
    }
    // Bail if the modal was closed, or a newer navigation superseded this one,
    // while the request was in flight.
    if (this._fleetDirBrowser !== browser || browser.reqId !== reqId) return;
    browser.loading = false;
    if (!result) {
      browser.error = '无法加载目录(设备离线或路径无效)';
      this.showToast('加载目录失败', 'error');
      this._renderFleetDirBrowser();
      return;
    }
    browser.relPath = relPath || '';
    browser.absPath = result.path;
    browser.dirs = result.dirs;
    this._renderFleetDirBrowser();
  },

  /** Render the breadcrumb + directory list from `this._fleetDirBrowser`. */
  _renderFleetDirBrowser() {
    const browser = this._fleetDirBrowser;
    const crumbEl = this.$('fleetDirBreadcrumb');
    const listEl = this.$('fleetDirList');
    if (!browser || !crumbEl || !listEl) return;

    // Breadcrumb is rendered relative to the home root (labeled '~') — the
    // endpoint never returns anything outside home, so there is no ".." above it.
    const segments = browser.relPath ? browser.relPath.split('/') : [];
    const crumbs = ['~', ...segments];
    crumbEl.innerHTML = crumbs
      .map((seg, i) => {
        const isLast = i === crumbs.length - 1;
        const label = i === 0 ? '~' : escapeHtml(seg);
        if (isLast) return `<span class="fleet-dir-crumb current">${label}</span>`;
        const targetRel = segments.slice(0, i).join('/');
        const targetJson = escapeHtml(JSON.stringify(targetRel));
        return `<span class="fleet-dir-crumb" role="button" tabindex="0" onclick="app._loadFleetDir(${targetJson})" onkeydown="if(event.key==='Enter'){app._loadFleetDir(${targetJson})}">${label}</span><span class="fleet-dir-crumb-sep" aria-hidden="true">/</span>`;
      })
      .join('');

    if (browser.loading) {
      listEl.innerHTML = '<div class="fleet-dir-loading">加载中&hellip;</div>';
    } else if (browser.error) {
      listEl.innerHTML = `<div class="fleet-dir-error">${escapeHtml(browser.error)}</div>`;
    } else if (browser.dirs.length === 0) {
      listEl.innerHTML = '<div class="fleet-dir-empty">无子目录</div>';
    } else {
      listEl.innerHTML = browser.dirs
        .map((name) => {
          const nextRel = browser.relPath ? `${browser.relPath}/${name}` : name;
          const nextJson = escapeHtml(JSON.stringify(nextRel));
          return `<button type="button" class="fleet-dir-entry" onclick="app._loadFleetDir(${nextJson})">
              <span class="fleet-dir-entry-icon" aria-hidden="true">&#128193;</span>
              <span class="fleet-dir-entry-name">${escapeHtml(name)}</span>
            </button>`;
        })
        .join('');
    }

    const selectBtn = this.$('fleetDirSelectBtn');
    if (selectBtn) selectBtn.disabled = browser.loading || !!browser.error;
  },

  /** "选择此目录" — fill the create-form workingDir input with the resolved absolute path. */
  selectFleetDirCurrent() {
    const browser = this._fleetDirBrowser;
    if (!browser || !browser.absPath || browser.loading || browser.error) return;
    // Capture before closeFleetDirBrowser() nulls out this._fleetDirBrowser.
    const absPath = browser.absPath;
    const onSelect = browser.onSelect;
    this.closeFleetDirBrowser();
    if (onSelect) {
      onSelect(absPath);
      return;
    }
    const dirEl = this.$('fleetCreateDir');
    if (dirEl) dirEl.value = absPath;
  },

  // ─── Quick-start working-directory chooser (Task B, spec §#3) ────────────────
  //
  // A small app modal (#quickStartDirModal — NO native prompt) popped by the
  // welcome Run buttons before a session is created: a text input with the same
  // smart candidates as the panel create-form (existing-session dirs ∪
  // resume-candidate dirs for the target device) plus a "浏览…" button that
  // reuses the #fleetDirModal breadcrumb browser. Works for the local device
  // and remotes identically (fleetListDirs/fleetResumeCandidates accept 'local').
  // pickWorkingDir() wraps it as a Promise<dir|null> — resolve(dir) on Start,
  // resolve(null) on Cancel/backdrop/Escape — so callers can `await` a choice.

  /**
   * Open the chooser for `deviceId` and resolve with the selected absolute dir
   * (or null if cancelled). `opts.mode` labels the hint; `opts.defaultDir`
   * pre-fills the input (last-used dir, resolved by the caller).
   * @returns {Promise<string|null>}
   */
  pickWorkingDir(deviceId, opts = {}) {
    return new Promise((resolve) => {
      // Only one chooser at a time — resolve any prior open one as a cancel.
      if (this._quickStartDirResolve) {
        const prev = this._quickStartDirResolve;
        this._quickStartDirResolve = null;
        prev(null);
      }
      const modal = this.$('quickStartDirModal');
      const input = this.$('quickStartDirInput');
      if (!modal || !input) {
        resolve(null);
        return;
      }
      this._quickStartDirResolve = resolve;
      this._quickStartDirDeviceId = deviceId || 'local';

      input.value = opts.defaultDir || '';

      const hint = this.$('quickStartDirHint');
      if (hint) hint.textContent = this._quickStartDirHintText(this._quickStartDirDeviceId, opts.mode);

      // Smart candidates for this device (session dirs ∪ resume dirs).
      this._refreshFleetDirCandidates(this._quickStartDirDeviceId, 'quickStartDirCandidates');

      modal.classList.add('active');
      this._quickStartDirKeyHandler = (ev) => {
        if (ev.key === 'Escape') {
          ev.preventDefault();
          this._closeQuickStartDir(null);
        } else if (ev.key === 'Enter' && ev.target === input) {
          ev.preventDefault();
          this._confirmQuickStartDir();
        }
      };
      document.addEventListener('keydown', this._quickStartDirKeyHandler);
      // Focus synchronously (still inside the click gesture) so iOS opens the
      // keyboard — mirrors the terminal.focus() rationale in runClaude.
      try {
        input.focus();
      } catch {
        /* focus is best-effort */
      }
    });
  },

  /** Hint line for the chooser — real device name when known (never "本机"). */
  _quickStartDirHintText(deviceId, mode) {
    const devices = (this._fleetState && this._fleetState.devices) || [];
    const d = devices.find((x) => x.id === deviceId);
    const name = d && (d.name || d.hostname);
    const modeLabel = mode ? ` ${mode}` : '';
    return name ? `→ 在 ${name} 上启动${modeLabel}` : `选择工作目录后启动${modeLabel}`;
  },

  /** "浏览…" in the chooser — open the breadcrumb browser, fill the input on pick. */
  openQuickStartDirBrowse() {
    const deviceId = this._quickStartDirDeviceId || 'local';
    this.openFleetDirBrowser({
      deviceId,
      onSelect: (absPath) => {
        const input = this.$('quickStartDirInput');
        if (input) input.value = absPath;
      },
    });
  },

  /** "启动" — require a non-empty dir (no native dialog), then resolve with it. */
  _confirmQuickStartDir() {
    const input = this.$('quickStartDirInput');
    const dir = input && input.value.trim();
    if (!dir) {
      if (input) {
        input.classList.add('input-error');
        input.focus();
        setTimeout(() => input.classList.remove('input-error'), 1200);
      }
      return;
    }
    this._closeQuickStartDir(dir);
  },

  /** Close the chooser and resolve its promise with `result` (null = cancel). */
  _closeQuickStartDir(result) {
    const modal = this.$('quickStartDirModal');
    if (modal) modal.classList.remove('active');
    if (this._quickStartDirKeyHandler) {
      document.removeEventListener('keydown', this._quickStartDirKeyHandler);
      this._quickStartDirKeyHandler = null;
    }
    const resolve = this._quickStartDirResolve;
    this._quickStartDirResolve = null;
    if (resolve) resolve(result || null);
  },

  /** Per-device last-used working dir (localStorage `codeman:last-workdir`). */
  _loadLastWorkdir(deviceId) {
    try {
      const raw = localStorage.getItem('codeman:last-workdir');
      if (!raw) return '';
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object') return obj[deviceId] || obj.__last || '';
      if (typeof obj === 'string') return obj; // legacy single-string value
    } catch {
      /* ignore malformed / unavailable storage */
    }
    return '';
  },

  _saveLastWorkdir(deviceId, dir) {
    if (!dir) return;
    try {
      let obj = {};
      const raw = localStorage.getItem('codeman:last-workdir');
      if (raw) {
        try {
          const p = JSON.parse(raw);
          if (p && typeof p === 'object') obj = p;
        } catch {
          /* overwrite malformed */
        }
      }
      obj[deviceId] = dir;
      obj.__last = dir;
      localStorage.setItem('codeman:last-workdir', JSON.stringify(obj));
    } catch {
      /* storage may be unavailable (private mode) — non-fatal */
    }
  },
});
