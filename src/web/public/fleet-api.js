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
});
