/**
 * @fileoverview Ultracode / Workflow run visualization — master-detail dock panel.
 *
 * Mirrors Claude Code's "working agents" TUI: LEFT pane = runs and their phases
 * (selectable "tasks"), RIGHT pane = the selected run's agents with model, live
 * state, TOKENS burned, and TOOL CALLS. Opt-in via the `showUltracodeAgents`
 * setting; the launcher button + panel are hidden until enabled.
 *
 * Data: run SUMMARIES arrive via getLightState (`data.workflowRuns`) and the
 * `workflow:run_*` SSE events (LEFT list). The full run (with agents[]) is fetched
 * per-run from GET /api/workflows/:runId when a run is selected (RIGHT pane).
 *
 * Standalone: reads only the workflow-run endpoints; never touches subagent state.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @loadorder 11.5 (after panels-ui.js, before session-ui.js)
 */
/* global CodemanApp, SSE_EVENTS, escapeHtml */

Object.assign(CodemanApp.prototype, {
  /** Ensure workflow state maps exist (lazy — constructor also seeds them). */
  _ensureWorkflowState() {
    if (!this.workflowRuns) this.workflowRuns = new Map(); // runId -> summary
    if (!this.workflowRunDetails) this.workflowRunDetails = new Map(); // runId -> full run (with agents)
    if (this.activeWorkflowRunId === undefined) this.activeWorkflowRunId = null;
    if (this.activeWorkflowPhaseIndex === undefined) this.activeWorkflowPhaseIndex = null;
  },

  /** Seed the LEFT list from a getLightState snapshot (array of run summaries). */
  seedWorkflowRuns(summaries) {
    this._ensureWorkflowState();
    this.workflowRuns.clear();
    (summaries || []).forEach((s) => this.workflowRuns.set(s.runId, s));
    this.renderUltracodeAgentsPanel();
  },

  // ----- SSE handlers (wired in app.js _SSE_HANDLER_MAP) -----
  _onWorkflowRunDiscovered(data) {
    this._upsertWorkflowRun(data);
  },
  _onWorkflowRunUpdated(data) {
    this._upsertWorkflowRun(data);
  },
  _onWorkflowRunRemoved(data) {
    this._ensureWorkflowState();
    if (!data || !data.runId) return;
    this.workflowRuns.delete(data.runId);
    this.workflowRunDetails.delete(data.runId);
    if (this.activeWorkflowRunId === data.runId) this.activeWorkflowRunId = null;
    this.renderUltracodeAgentsPanel();
  },

  _upsertWorkflowRun(summary) {
    this._ensureWorkflowState();
    if (!summary || !summary.runId) return;
    this.workflowRuns.set(summary.runId, summary);
    // If the live-updating run is the one open in the detail pane, refresh its agents.
    if (this.activeWorkflowRunId === summary.runId) {
      this._fetchWorkflowRunDetail(summary.runId);
    }
    this.renderUltracodeAgentsPanel();
  },

  // ----- Panel open/close -----
  toggleUltracodeAgentsPanel() {
    const panel = document.getElementById('ultracodeAgentsPanel');
    if (!panel) return;
    panel.classList.remove('hidden');
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) this.renderUltracodeAgentsPanel();
  },
  closeUltracodeAgentsPanel() {
    const panel = document.getElementById('ultracodeAgentsPanel');
    if (panel) panel.classList.remove('open');
  },

  // ----- Selection -----
  selectWorkflowRun(runId) {
    this._ensureWorkflowState();
    this.activeWorkflowRunId = runId;
    this.activeWorkflowPhaseIndex = null; // reset phase filter on run change
    this._fetchWorkflowRunDetail(runId);
    this.renderUltracodeAgentsPanel();
  },
  selectWorkflowPhase(phaseIndex) {
    this._ensureWorkflowState();
    // phaseIndex null => show all phases
    this.activeWorkflowPhaseIndex = phaseIndex === null || phaseIndex === undefined ? null : Number(phaseIndex);
    this._renderUltracodeDetail();
  },

  async _fetchWorkflowRunDetail(runId) {
    try {
      const res = await fetch(`/api/workflows/${encodeURIComponent(runId)}`);
      const env = await res.json();
      const run = env && env.success ? env.data : null;
      if (run) {
        this.workflowRunDetails.set(runId, run);
        if (this.activeWorkflowRunId === runId) this._renderUltracodeDetail();
      }
    } catch {
      /* transient — next update retries */
    }
  },

  // ----- Render (debounced) -----
  renderUltracodeAgentsPanel() {
    clearTimeout(this._ultracodeRenderTimer);
    this._ultracodeRenderTimer = setTimeout(() => this._renderUltracodeAgentsPanelImmediate(), 150);
  },

  _renderUltracodeAgentsPanelImmediate() {
    this._ensureWorkflowState();
    const panel = document.getElementById('ultracodeAgentsPanel');
    if (!panel) return;
    const badge = document.getElementById('ultracodeCountBadge');
    if (badge) badge.textContent = this.workflowRuns.size ? String(this.workflowRuns.size) : '';
    this._renderUltracodeRunList();
    this._renderUltracodeDetail();
  },

  _renderUltracodeRunList() {
    const list = document.getElementById('ultracodeRunList');
    if (!list) return;
    const runs = Array.from(this.workflowRuns.values()).sort(
      (a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0)
    );
    if (!runs.length) {
      list.innerHTML = '<div class="subagent-empty">No ultracode runs detected</div>';
      return;
    }
    list.innerHTML = runs.map((r) => this._workflowRunRowHtml(r)).join('');
  },

  _workflowRunRowHtml(r) {
    const active = r.runId === this.activeWorkflowRunId;
    const name = escapeHtml(r.workflowName || r.summary || r.runId);
    const status = String(r.status || '');
    const statusCls = this._workflowStatusClass(status);
    const stats = `${r.agentCount ?? 0} agents · ${this._fmtNum(r.totalTokens)} tok · ${r.totalToolCalls ?? 0} tools`;
    let phasesHtml = '';
    if (active && Array.isArray(r.phases) && r.phases.length) {
      const allActive = this.activeWorkflowPhaseIndex === null ? ' selected' : '';
      const chips = [
        `<div class="ultracode-phase-chip${allActive}" onclick="event.stopPropagation();app.selectWorkflowPhase(null)">All</div>`,
      ];
      r.phases.forEach((p, i) => {
        const sel = this.activeWorkflowPhaseIndex === i + 1 ? ' selected' : '';
        chips.push(
          `<div class="ultracode-phase-chip${sel}" title="${escapeHtml(p.detail || '')}" onclick="event.stopPropagation();app.selectWorkflowPhase(${i + 1})">${escapeHtml(p.title || 'Phase ' + (i + 1))}</div>`
        );
      });
      phasesHtml = `<div class="ultracode-phase-list">${chips.join('')}</div>`;
    }
    return (
      `<div class="ultracode-run-item${active ? ' selected' : ''}" onclick="app.selectWorkflowRun('${escapeHtml(r.runId)}')">` +
      `<div class="ultracode-run-head"><span class="ultracode-run-name">${name}</span>` +
      `<span class="ultracode-status ${statusCls}">${escapeHtml(status || '—')}</span></div>` +
      `<div class="ultracode-run-stats">${escapeHtml(stats)}</div>` +
      phasesHtml +
      `</div>`
    );
  },

  _renderUltracodeDetail() {
    const detail = document.getElementById('ultracodeAgentGrid');
    if (!detail) return;
    const runId = this.activeWorkflowRunId;
    if (!runId) {
      detail.innerHTML = '<div class="subagent-empty">Select a run to view its agents</div>';
      return;
    }
    const run = this.workflowRunDetails.get(runId);
    if (!run) {
      detail.innerHTML = '<div class="subagent-empty">Loading agents…</div>';
      return;
    }
    const phases = Array.isArray(run.phases) ? run.phases : [];
    let agents = Array.isArray(run.agents) ? run.agents : [];
    if (this.activeWorkflowPhaseIndex !== null) {
      agents = agents.filter((a) => a.phaseIndex === this.activeWorkflowPhaseIndex);
    }
    if (!agents.length) {
      detail.innerHTML = '<div class="subagent-empty">No agents in this view</div>';
      return;
    }
    // Group agents by phaseIndex, in phase order.
    const groups = new Map();
    agents.forEach((a) => {
      const key = a.phaseIndex || 0;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    });
    const orderedKeys = Array.from(groups.keys()).sort((a, b) => a - b);
    const html = orderedKeys
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
    detail.innerHTML = html;
  },

  _workflowAgentCardHtml(a) {
    const state = String(a.state || 'start');
    const stateCls = this._workflowAgentStateClass(state);
    const stateLabel = state === 'start' ? 'queued' : state === 'progress' ? 'running' : state;
    const model = this._modelShort(a.model);
    const tokens = a.tokens === undefined ? '—' : this._fmtNum(a.tokens);
    const tools = a.toolCalls === undefined ? '—' : String(a.toolCalls);
    let secondary = '';
    if (state === 'done' && a.resultPreview) {
      secondary = escapeHtml(a.resultPreview);
    } else if (a.lastToolName) {
      secondary = escapeHtml(a.lastToolName + (a.lastToolSummary ? ' · ' + a.lastToolSummary : ''));
    }
    return (
      `<div class="ultracode-agent-card">` +
      `<div class="ultracode-agent-top">` +
      `<span class="ultracode-agent-label">${escapeHtml(a.label || 'agent')}</span>` +
      `<span class="ultracode-agent-state ${stateCls}">${escapeHtml(stateLabel)}</span>` +
      `</div>` +
      `<div class="ultracode-agent-meta">` +
      `<span class="ultracode-chip" title="model">${escapeHtml(model)}</span>` +
      `<span class="ultracode-chip ultracode-chip-tok" title="tokens burned">${tokens} tok</span>` +
      `<span class="ultracode-chip ultracode-chip-tool" title="tool calls">${tools} tools</span>` +
      `</div>` +
      (secondary ? `<div class="ultracode-agent-sub">${secondary}</div>` : '') +
      `</div>`
    );
  },

  // ----- helpers -----
  _workflowStatusClass(status) {
    if (status === 'completed') return 'completed';
    if (status === 'running') return 'active';
    if (status === 'killed' || status === 'failed') return 'failed';
    return '';
  },
  _workflowAgentStateClass(state) {
    if (state === 'done') return 'completed';
    if (state === 'progress') return 'active';
    return 'idle'; // start / queued
  },
  _modelShort(model) {
    if (!model) return '';
    return String(model)
      .replace(/^claude-/, '')
      .replace(/-\d{8}$/, '');
  },
  _fmtNum(n) {
    if (n === undefined || n === null) return '0';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  },
});
