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
 *   - workingDir picker (Task 25, spec §12.5): the input carries a `<datalist>`
 *     of recent candidates — the selected device's live session workingDirs ∪
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
 *     server-sourced directory name/path (dir browser + datalist candidates)
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
 *   fleetResumeCandidates/fleetListDirs),
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
    const createSel = this.$('fleetCreateDevice');
    this._refreshFleetDirCandidates(createSel && createSel.value);
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

  // ─── workingDir smart dropdown (Task 25) ────────────────────────────────────

  /** Create-form device <select> onchange — refresh the workingDir `<datalist>`. */
  onFleetCreateDeviceChange() {
    const sel = this.$('fleetCreateDevice');
    this._refreshFleetDirCandidates(sel && sel.value);
  },

  /**
   * (Re)build the workingDir `<datalist>` candidates for `deviceId`: that
   * device's live session workingDirs (fresh off `this._fleetState` every
   * call) ∪ its resume-candidate workingDirs (fetched once per device and
   * cached in `this._fleetDirCandCache` for the panel's lifetime — switching
   * devices back and forth doesn't refetch). Silent-fails to an empty resume
   * set on any error (offline/timeout/network); the session-derived half of
   * the list is unaffected either way. Manual typing into the input always
   * works regardless of what's in the datalist.
   */
  async _refreshFleetDirCandidates(deviceId) {
    this._renderFleetDirDatalist(deviceId);
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
    const sel = this.$('fleetCreateDevice');
    if (sel && sel.value === deviceId) this._renderFleetDirDatalist(deviceId);
  },

  /**
   * Merge the two candidate sources, dedup by workingDir keeping the most
   * recent timestamp, sort most-recent-first, cap at 15, and paint the
   * `<datalist>`. All values escaped (remote workingDirs are untrusted).
   */
  _renderFleetDirDatalist(deviceId) {
    const list = this.$('fleetDirCandidates');
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

    list.innerHTML = ranked.map((dir) => `<option value="${escapeHtml(dir)}"></option>`).join('');
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
  openFleetDirBrowser() {
    const sel = this.$('fleetCreateDevice');
    const deviceId = sel && sel.value;
    if (!deviceId) {
      this.showToast('请先选择一个在线设备', 'warning');
      return;
    }
    this._fleetDirBrowser = { deviceId, relPath: '', absPath: '', dirs: [], loading: false, error: null, reqId: 0 };
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
    const dirEl = this.$('fleetCreateDir');
    if (dirEl) dirEl.value = browser.absPath;
    this.closeFleetDirBrowser();
  },
});
