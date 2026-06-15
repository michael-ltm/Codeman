/**
 * @fileoverview Ultracode floating run windows — auto-popping draggable windows
 * with a connector line to the originating session tab.
 *
 * This is the "floating thing" companion to the docked master-detail panel in
 * `ultracode-panel.js` (the dock panel stays — these windows are ADDITIONAL).
 * When the `showUltracodeAgents` setting is on, a small floating window pops up
 * for each ACTIVE ultracode/Workflow run (status not completed/killed/failed),
 * mirroring the live agent grid, and is connected by a glowing line to the
 * Codeman tab whose `claudeSessionId` matches the run's `sessionUuid` — the same
 * line idiom subagent windows use. The window auto-closes a few seconds after
 * its run finishes; an explicitly-closed run is remembered and never re-pops.
 *
 * Reuses, rather than duplicates:
 *  - `makeWindowDraggable` + the shared `#connectionLines` SVG (subagent-windows.js)
 *  - `_workflowAgentCardHtml`, `_fmtNum`, `_workflowStatusClass`, `_fetchWorkflowRunDetail`,
 *    and the `workflowRuns` / `workflowRunDetails` maps (ultracode-panel.js)
 *
 * The connector-line draw is appended to the shared SVG from inside
 * `_updateConnectionLinesImmediate` (subagent-windows.js calls
 * `_appendUltracodeConnectionLines` at the end of its render pass), so both the
 * subagent and ultracode lines live in one batched read→write reflow pass.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency subagent-windows.js (makeWindowDraggable, updateConnectionLines, #connectionLines)
 * @dependency ultracode-panel.js (workflowRuns/workflowRunDetails, _workflowAgentCardHtml, _fmtNum)
 * @loadorder 15.5 (after subagent-windows.js — needs makeWindowDraggable at runtime)
 */
/* global CodemanApp, escapeHtml */

Object.assign(CodemanApp.prototype, {
  /** Lazily seed the floating-window state maps (constructor also seeds them). */
  _ensureUltracodeWindowState() {
    if (!this.ultracodeWindows) this.ultracodeWindows = new Map(); // runId -> { element, parentSessionId, dragListeners, collapsed }
    if (!this.ultracodeWindowsClosed) this.ultracodeWindowsClosed = new Set(); // runIds the user dismissed
    if (!this.ultracodeWindowCloseTimers) this.ultracodeWindowCloseTimers = new Map(); // runId -> setTimeout id
    if (this.ultracodeWindowZIndex === undefined) this.ultracodeWindowZIndex = 1000;
  },

  /** Floating windows have their own opt-in (default OFF), independent of the dock panel. */
  _ultracodeFloatingEnabled() {
    const settings = this.loadAppSettingsFromStorage ? this.loadAppSettingsFromStorage() : {};
    return !!(settings && settings.ultracodeFloatingWindows);
  },

  /** A run is "working" until it reaches a terminal status. Mid-run status is absent. */
  _isWorkflowRunActive(run) {
    const s = String((run && run.status) || '');
    return !(s === 'completed' || s === 'killed' || s === 'failed');
  },

  /**
   * Resolve which Codeman tab a run belongs to: the session whose
   * `claudeSessionId` equals the run's `sessionUuid` (the path segment the watcher
   * captured). Falls back to the active session so the line still lands somewhere.
   */
  _resolveUltracodeParentSession(run) {
    const uuid = run && run.sessionUuid;
    if (uuid && this.sessions) {
      for (const [sessionId, session] of this.sessions) {
        if (session && session.claudeSessionId === uuid) return sessionId;
      }
    }
    if (this.activeSessionId && this.sessions && this.sessions.has(this.activeSessionId)) {
      return this.activeSessionId;
    }
    return null;
  },

  /**
   * Auto-pop driver — called for every run discovered/updated and on reconnect seed.
   * Creates a floating window for active runs, refreshes existing ones, and schedules
   * an auto-close once a run finishes.
   */
  _syncUltracodeFloatingWindow(run, opts) {
    this._ensureUltracodeWindowState();
    if (!run || !run.runId) return;
    if (!this._ultracodeFloatingEnabled()) return;
    const runId = run.runId;
    if (this.ultracodeWindowsClosed.has(runId)) return; // respect explicit dismissal

    const active = this._isWorkflowRunActive(run);
    const existing = this.ultracodeWindows.get(runId);

    if (active) {
      // Run is alive — cancel any pending auto-close.
      const pending = this.ultracodeWindowCloseTimers.get(runId);
      if (pending) {
        clearTimeout(pending);
        this.ultracodeWindowCloseTimers.delete(runId);
      }
      if (existing) {
        this.renderUltracodeWindowContent(runId);
        this._fetchWorkflowRunDetail(runId); // refresh agents[]; re-renders window on land
      } else {
        // On a reconnect snapshot, only restore windows for genuinely recent runs so
        // a backlog of stale undefined-status runs doesn't carpet the screen.
        if (opts && opts.fromSeed) {
          const FLOAT_SEED_MAX_AGE_MS = 5 * 60 * 1000;
          const age = Date.now() - (run.lastActivityAt || 0);
          if (!(run.lastActivityAt && age < FLOAT_SEED_MAX_AGE_MS)) return;
        }
        this.createUltracodeWindow(run);
      }
    } else if (existing) {
      // Finished — refresh to the final state (status + final agent states), show it
      // briefly, then retire the floating window.
      this._fetchWorkflowRunDetail(runId);
      this.renderUltracodeWindowContent(runId);
      if (!this.ultracodeWindowCloseTimers.has(runId)) {
        const FLOAT_FINISH_GRACE_MS = 8000;
        const timer = setTimeout(() => {
          this.ultracodeWindowCloseTimers.delete(runId);
          this.closeUltracodeWindow(runId, false);
        }, FLOAT_FINISH_GRACE_MS);
        this.ultracodeWindowCloseTimers.set(runId, timer);
      }
    }
  },

  /** Build and mount a floating window for a run, positioned near its parent tab. */
  createUltracodeWindow(run) {
    this._ensureUltracodeWindowState();
    const runId = run.runId;
    if (this.ultracodeWindows.has(runId)) return;
    const parentSessionId = this._resolveUltracodeParentSession(run);
    const titleText = run.workflowName || run.summary || runId;

    const win = document.createElement('div');
    win.className = 'ultracode-window spawning';
    win.id = `ultracode-window-${runId}`;
    win.style.zIndex = ++this.ultracodeWindowZIndex;
    win.innerHTML = `
      <div class="ultracode-window-header">
        <div class="ultracode-window-title" title="${escapeHtml(titleText)}">
          <span class="icon">🧬</span>
          <span class="uw-name">${escapeHtml(titleText)}</span>
          <span class="uw-status"></span>
        </div>
        <div class="ultracode-window-actions">
          <button class="uw-min" type="button" title="Collapse">─</button>
          <button class="uw-close" type="button" title="Close">&times;</button>
        </div>
      </div>
      <div class="ultracode-window-body" id="ultracode-window-body-${runId}">
        <div class="subagent-empty">Loading agents…</div>
      </div>
    `;

    // Position: spawn from the parent tab if we can find it, else cascade.
    const parentTab = parentSessionId ? document.querySelector(`.session-tab[data-id="${parentSessionId}"]`) : null;
    if (parentTab) {
      const r = parentTab.getBoundingClientRect();
      const left = Math.max(8, Math.min(r.left, window.innerWidth - 392));
      win.style.left = `${left}px`;
      win.style.top = `${r.bottom + 14}px`;
    } else {
      const n = this.ultracodeWindows.size;
      win.style.left = `${24 + n * 26}px`;
      win.style.top = `${96 + n * 26}px`;
    }

    document.body.appendChild(win);
    // Drop the spawn class on the next frame so the transition runs.
    requestAnimationFrame(() => win.classList.remove('spawning'));

    const header = win.querySelector('.ultracode-window-header');
    const dragListeners = this.makeWindowDraggable(win, header);

    win.querySelector('.uw-min').addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleUltracodeWindowCollapse(runId);
    });
    win.querySelector('.uw-close').addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeUltracodeWindow(runId, true);
    });
    const nameEl = win.querySelector('.uw-name');
    if (parentSessionId) {
      nameEl.style.cursor = 'pointer';
      nameEl.title = 'Go to session';
      nameEl.addEventListener('click', () => this.selectSession(parentSessionId));
    }

    this.ultracodeWindows.set(runId, { element: win, parentSessionId, dragListeners, collapsed: false });

    this.renderUltracodeWindowContent(runId);
    this._fetchWorkflowRunDetail(runId); // pull agents[] for the body
    this.updateConnectionLines();
  },

  /** Collapse/expand the window to header-only (line stays connected). */
  toggleUltracodeWindowCollapse(runId) {
    const data = this.ultracodeWindows.get(runId);
    if (!data) return;
    data.collapsed = !data.collapsed;
    data.element.classList.toggle('collapsed', data.collapsed);
    this.updateConnectionLines();
  },

  /** Remove a floating window. `userInitiated` records a dismissal so it won't re-pop. */
  closeUltracodeWindow(runId, userInitiated) {
    this._ensureUltracodeWindowState();
    const pending = this.ultracodeWindowCloseTimers.get(runId);
    if (pending) {
      clearTimeout(pending);
      this.ultracodeWindowCloseTimers.delete(runId);
    }
    const data = this.ultracodeWindows.get(runId);
    if (userInitiated) this.ultracodeWindowsClosed.add(runId);
    if (!data) return;
    this._teardownUltracodeDrag(data.dragListeners);
    data.element.remove();
    this.ultracodeWindows.delete(runId);
    this.updateConnectionLines();
  },

  /** Detach the document-level drag listeners returned by makeWindowDraggable. */
  _teardownUltracodeDrag(dl) {
    if (!dl) return;
    document.removeEventListener('mousemove', dl.move);
    document.removeEventListener('mouseup', dl.up);
    if (dl.touchMove) {
      document.removeEventListener('touchmove', dl.touchMove);
      document.removeEventListener('touchend', dl.up);
      document.removeEventListener('touchcancel', dl.up);
    }
    if (dl.handle) {
      dl.handle.removeEventListener('mousedown', dl.handleMouseDown);
      dl.handle.removeEventListener('touchstart', dl.handleTouchStart);
    }
  },

  /** Tear down every floating window (called on SSE reconnect; keeps user dismissals). */
  removeAllUltracodeWindows() {
    this._ensureUltracodeWindowState();
    const had = this.ultracodeWindows.size > 0;
    for (const [, data] of this.ultracodeWindows) {
      this._teardownUltracodeDrag(data.dragListeners);
      if (data.element) data.element.remove();
    }
    this.ultracodeWindows.clear();
    for (const t of this.ultracodeWindowCloseTimers.values()) clearTimeout(t);
    this.ultracodeWindowCloseTimers.clear();
    // Redraw so the now-orphaned connector lines are cleared from the shared SVG.
    if (had) this.updateConnectionLines();
  },

  /** When the feature is toggled on, pop windows for any currently-active runs. */
  syncAllUltracodeFloatingWindows() {
    this._ensureUltracodeWindowState();
    if (!this._ultracodeFloatingEnabled()) {
      this.removeAllUltracodeWindows();
      return;
    }
    if (!this.workflowRuns) return;
    for (const run of this.workflowRuns.values()) {
      this._syncUltracodeFloatingWindow(run, { fromSeed: true });
    }
  },

  /** Refresh a floating window's header + body from the latest summary/detail. */
  renderUltracodeWindowContent(runId) {
    const data = this.ultracodeWindows.get(runId);
    if (!data) return;
    const summary = this.workflowRuns && this.workflowRuns.get(runId);
    const detail = this.workflowRunDetails && this.workflowRunDetails.get(runId);
    // Summary is the freshest run-level info (every SSE tick); detail supplies agents[]
    // but is fetched less often. Merge so a completed summary isn't masked by stale detail.
    const run = summary && detail ? { ...detail, ...summary, agents: detail.agents } : detail || summary;
    if (!run) return;

    const nameEl = data.element.querySelector('.uw-name');
    if (nameEl) nameEl.textContent = run.workflowName || run.summary || runId;

    const statusEl = data.element.querySelector('.uw-status');
    if (statusEl) {
      const finished = !this._isWorkflowRunActive(run);
      const label = run.status ? String(run.status) : finished ? '—' : 'running';
      const clsKey = run.status ? run.status : finished ? '' : 'running';
      statusEl.textContent = label;
      statusEl.className = 'uw-status ultracode-status ' + this._workflowStatusClass(clsKey);
    }

    const body = data.element.querySelector('.ultracode-window-body');
    if (body) body.innerHTML = this._ultracodeWindowBodyHtml(run);
  },

  /** Compact body: a stats line + agent cards grouped by phase (reuses panel helpers). */
  _ultracodeWindowBodyHtml(run) {
    const phases = Array.isArray(run.phases) ? run.phases : [];
    const agents = Array.isArray(run.agents) ? run.agents : null;
    const agentCount = run.agentCount ?? (agents ? agents.length : 0);
    const head = `<div class="uw-summary">${this._fmtNum(run.totalTokens)} tok · ${run.totalToolCalls ?? 0} tools · ${agentCount} agents</div>`;

    if (!agents) {
      // Summary-only (detail not fetched yet): show phase chips as a teaser.
      if (phases.length) {
        const chips = phases
          .map(
            (p) =>
              `<span class="ultracode-phase-chip" title="${escapeHtml(p.detail || '')}">${escapeHtml(p.title || '')}</span>`
          )
          .join('');
        return (
          head + `<div class="ultracode-phase-list">${chips}</div><div class="subagent-empty">Loading agents…</div>`
        );
      }
      return head + '<div class="subagent-empty">Loading agents…</div>';
    }
    if (!agents.length) return head + '<div class="subagent-empty">No agents yet</div>';

    const groups = new Map();
    agents.forEach((a) => {
      const key = a.phaseIndex || 0;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    });
    const orderedKeys = Array.from(groups.keys()).sort((a, b) => a - b);
    const grid = orderedKeys
      .map((key) => {
        const group = groups.get(key);
        const title = (phases[key - 1] && phases[key - 1].title) || `Phase ${key}`;
        const tok = group.reduce((s, a) => s + (a.tokens || 0), 0);
        const tools = group.reduce((s, a) => s + (a.toolCalls || 0), 0);
        const header =
          `<div class="ultracode-phase-header"><span>${escapeHtml(title)}</span>` +
          `<span class="ultracode-phase-sub">${this._fmtNum(tok)} tok · ${tools} tools</span></div>`;
        return header + group.map((a) => this._workflowAgentCardHtml(a)).join('');
      })
      .join('');
    return head + grid;
  },

  /**
   * Append ultracode-window → parent-tab connector lines into the shared SVG.
   * Invoked at the tail of `_updateConnectionLinesImmediate` (subagent-windows.js),
   * so it shares that pass's batched read/write discipline. `rects` is the tab-rect
   * cache already populated for subagent lines — reuse it, fill any gaps.
   */
  _appendUltracodeConnectionLines(svg, rects) {
    this._ensureUltracodeWindowState();
    if (!svg || !this.ultracodeWindows.size) return;
    if (!rects) rects = new Map();

    // PHASE 1: layout reads (resolve parents, batch getBoundingClientRect).
    const winList = [];
    for (const [runId, data] of this.ultracodeWindows) {
      if (!data.element) continue;
      if (!data.parentSessionId) {
        const summary = this.workflowRuns && this.workflowRuns.get(runId);
        if (summary) data.parentSessionId = this._resolveUltracodeParentSession(summary);
      }
      const parentSessionId = data.parentSessionId;
      if (!parentSessionId) continue;
      const tabKey = 'tab:' + parentSessionId;
      if (!rects.has(tabKey)) {
        const tab = document.querySelector(`.session-tab[data-id="${parentSessionId}"]`);
        if (tab) rects.set(tabKey, tab.getBoundingClientRect());
      }
      winList.push({ runId, parentSessionId, winRect: data.element.getBoundingClientRect() });
    }

    // PHASE 2: writes (curve from tab bottom-center to window top-center).
    for (const { runId, parentSessionId, winRect } of winList) {
      const tabRect = rects.get('tab:' + parentSessionId);
      if (!tabRect) continue;
      const x1 = tabRect.left + tabRect.width / 2;
      const y1 = tabRect.bottom;
      const x2 = winRect.left + winRect.width / 2;
      const y2 = winRect.top;
      const midY = (y1 + y2) / 2;
      const path = `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      line.setAttribute('d', path);
      line.setAttribute('class', 'connection-line ultracode-connection');
      line.setAttribute('data-run-id', runId);
      line.setAttribute('data-parent-tab', parentSessionId);
      svg.appendChild(line);
    }
  },
});
