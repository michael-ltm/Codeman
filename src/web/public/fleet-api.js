/**
 * @fileoverview Fleet REST API helpers mixed into CodemanApp.prototype.
 *
 * Thin wrappers over the centralized fetch helpers (api-client.js) for the
 * Fleet Dashboard's REST surface (Task 12): device/session state, pairing
 * codes, remote session create/stop, and terminal replay buffers.
 *
 * Envelope note (必查项 1): the server wraps every bare JSON payload as
 * `{ success:true, data }` (server.ts onSend hook). `_apiJson` already unwraps
 * that envelope (api-client.js), but `_apiPost`/`_apiDelete` return the RAW
 * Response. To keep every fleet method returning unwrapped data uniformly,
 * mutating calls route through `_apiJson` with an explicit method/body so their
 * results are unwrapped too — `listFleet()` therefore returns a bare
 * FleetDashboardState, and pairing/create return their bare data objects.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js (CodemanApp class must be defined)
 * @dependency api-client.js (_apiJson)
 * @loadorder after api-client.js
 */

Object.assign(CodemanApp.prototype, {
  /**
   * Fetch aggregate fleet state.
   * @returns {Promise<object|null>} FleetDashboardState (devices/sessions/sessionTabs/generatedAt) or null on error
   */
  async listFleet() {
    return this._apiJson('/api/fleet');
  },

  /**
   * Mint a one-time pairing code for joining a new device.
   * @returns {Promise<{code:string,expiresAt:number,joinCommand:string}|null>}
   */
  async fleetCreatePairingCode() {
    return this._apiJson('/api/fleet/pairing-codes', { method: 'POST', body: {} });
  },

  /**
   * Create a session on a (possibly remote) device.
   * @param {string} deviceId
   * @param {{workingDir:string,mode?:string,name?:string,prompt?:string}} payload
   * @returns {Promise<object|null>} FleetSessionSummary (has .id) or null on failure
   */
  async fleetCreateSession(deviceId, payload) {
    return this._apiJson(`/api/fleet/devices/${encodeURIComponent(deviceId)}/sessions`, {
      method: 'POST',
      body: payload,
    });
  },

  /**
   * Stop a session on a (possibly remote) device.
   * @param {string} deviceId
   * @param {string} sessionId
   * @returns {Promise<object|null>}
   */
  async fleetStopSession(deviceId, sessionId) {
    return this._apiJson(
      `/api/fleet/devices/${encodeURIComponent(deviceId)}/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'DELETE' }
    );
  },

  /**
   * Fetch the replayable terminal buffer for a device+session pair.
   * @param {string} deviceId
   * @param {string} sessionId
   * @returns {Promise<{buffer:string}|null>}
   */
  async fleetTerminalBuffer(deviceId, sessionId) {
    return this._apiJson(
      `/api/fleet/devices/${encodeURIComponent(deviceId)}/sessions/${encodeURIComponent(sessionId)}/terminal`
    );
  },

  /**
   * List resumable past conversations on a (possibly remote) device (Task 23).
   * Backs the cross-device Resume list on the welcome screen. `_apiJson` unwraps
   * the `{ success, data }` envelope → `{ candidates }`.
   * @param {string} deviceId
   * @returns {Promise<Array<{sessionId:string,workingDir:string,title:string,updatedAt:number,projectKey?:string}>|null>}
   *          candidate array, or null on any failure (offline 409 / timeout / network).
   */
  async fleetResumeCandidates(deviceId) {
    const data = await this._apiJson(`/api/fleet/devices/${encodeURIComponent(deviceId)}/resume-candidates`);
    if (!data || !Array.isArray(data.candidates)) return null;
    return data.candidates;
  },

  /**
   * List one level of a (possibly remote) device's directory tree, confined to
   * its $HOME (Task 25's working-dir browser). `path` should be a path
   * RELATIVE to $HOME (e.g. `'proj/src'`), never absolute — the node resolves
   * it under its own home directory (dir-listing.ts's `listDirsSafe`), which
   * sidesteps any cross-platform (POSIX vs Windows) separator mismatch between
   * this browser and the target device's OS. Omit `path` for the home root.
   * @param {string} deviceId
   * @param {string} [path] - home-relative subpath, e.g. 'proj/src'
   * @returns {Promise<{path:string,dirs:string[]}|null>} the resolved absolute
   *          path plus subdirectory names, or null on any failure (offline
   *          409 / outside-home 400 / network error).
   */
  async fleetListDirs(deviceId, path) {
    const qs = path ? `?path=${encodeURIComponent(path)}` : '';
    const data = await this._apiJson(`/api/fleet/devices/${encodeURIComponent(deviceId)}/dirs${qs}`);
    if (!data || typeof data.path !== 'string' || !Array.isArray(data.dirs)) return null;
    return data;
  },

  /**
   * Fetch discovered external (foreign-tmux) AI-CLI session candidates across
   * the whole fleet (Rev5 §13.3, Task 29). `_apiJson` unwraps the envelope to
   * `{ byDevice }`; this returns the bare map (empty object on any failure so
   * callers never need a null-check).
   * @returns {Promise<Record<string, Array<{socket:string,tmuxSession:string,mode:string,workingDir:string,firstSeenAt:number}>>>}
   */
  async fleetExternalSessions() {
    const data = await this._apiJson('/api/fleet/external-sessions');
    return (data && data.byDevice) || {};
  },

  /**
   * Adopt a discovered external tmux session as a first-class fleet session.
   * Unlike the other mutating helpers in this file, this returns the RAW
   * Response (not the unwrapped envelope) — the caller needs to branch on the
   * HTTP status (404 candidate vanished vs 409 device offline) for distinct
   * toasts, the same pattern `_handleTunnelEnableRefusal` uses in
   * settings-ui.js. `_apiJson`'s envelope-unwrap would collapse both failure
   * modes to `null` and lose that distinction.
   * @param {string} deviceId
   * @param {{socket:string, tmuxSession:string}} payload
   * @returns {Promise<Response|null>}
   */
  async fleetAdoptSession(deviceId, payload) {
    return this._apiPost(`/api/fleet/devices/${encodeURIComponent(deviceId)}/adopt-session`, payload);
  },
});
