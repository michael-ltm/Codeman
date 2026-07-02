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
 *   - Pairing: mint a one-time code → shows code + expiry countdown + a copyable
 *     `codeman node join …` command (copied via app._copyText, the codebase's
 *     clipboard helper, with a toast).
 *   - Remote session create form: device select (defaults to the in-panel
 *     selection; offline devices disabled), required workingDir, a mode
 *     segmented control (claude/codex/shell/gemini/opencode) → POST via
 *     fleet-api, then refreshFleetState + toast.
 *
 * Hard rules honored here:
 *   - NO native confirm/alert/prompt — the stop-session confirmation uses the
 *     app's own `#fleetStopModal` modal; everything else uses showToast.
 *   - Every device/session-sourced string flows through escapeHtml (device
 *     names/hostnames come from remote machines → untrusted).
 *   - Only existing CSS variables (follows data-skin).
 *
 * SSE refresh: fleet:* events map to refreshFleetState (app.js), which caches
 * `this._fleetState`, updates the header badge, and re-renders THIS panel while
 * it is open (hooks added to refreshFleetState in fleet-tabs.js).
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js (CodemanApp, this.$, this._copyText, showToast),
 *   fleet-api.js (fleetCreatePairingCode/fleetCreateSession/fleetStopSession),
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
    const localTag = isLocal ? ' <span class="fleet-local-tag">本机</span>' : '';
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
          <div class="fleet-device-name">${name}${localTag}</div>
          <div class="fleet-device-meta">
            ${platform ? `<span class="fleet-device-platform">${platform}</span>` : ''}
            <span class="fleet-device-sessions">${count} 会话</span>
            ${capTag}
          </div>
        </div>
      </div>${sessionsHtml}`;
  },

  /** One remote session row with a stop action. All strings escaped. */
  _fleetSessionHtml(device, session) {
    const key = `${session.deviceId}:${session.id}`;
    const status = escapeHtml(session.status || 'idle');
    const mode = session.mode || 'claude';
    const label = session.name || this._fleetBasename(session.workingDir) || session.id.slice(0, 8);
    const modeBadge = mode !== 'claude' ? `<span class="fleet-session-mode">${escapeHtml(mode)}</span>` : '';
    const keyJson = escapeHtml(JSON.stringify(key));
    const labelJson = escapeHtml(JSON.stringify(`${device.name || device.hostname || ''} / ${label}`));
    return `<div class="fleet-session">
        <span class="fleet-session-dot ${status}" aria-hidden="true"></span>
        <span class="fleet-session-label" title="${escapeHtml(session.workingDir || '')}">${modeBadge}${escapeHtml(label)}</span>
        <button type="button" class="fleet-session-stop" onclick="event.stopPropagation(); app.requestStopFleetSession(${keyJson}, ${labelJson})" title="停止远程会话" aria-label="Stop remote session">停止</button>
      </div>`;
  },

  /** Basename without importing node path (device workingDir is a string). */
  _fleetBasename(p) {
    if (!p || typeof p !== 'string') return '';
    const parts = p.split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
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
        const local = d.id === 'local' ? ' (本机)' : '';
        const suffix = online ? '' : ' — offline';
        return `<option value="${escapeHtml(d.id)}" ${online ? '' : 'disabled'}>${name}${local}${suffix}</option>`;
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
    this.showToast('远程会话已创建', 'success');
    this.refreshFleetState();
  },

  // ─── Stop remote session (modal confirm — NO native confirm) ────────────────

  /** Arm the stop-confirm modal for a remote session key. */
  requestStopFleetSession(key, label) {
    this._fleetStopPending = { key, label: label || key };
    const nameEl = this.$('fleetStopName');
    if (nameEl) nameEl.textContent = this._fleetStopPending.label;
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
        this.showToast('Remote session stopped', 'success');
      } catch {
        this.showToast('Failed to stop remote session', 'error');
      }
    }
    this.refreshFleetState();
  },
});
