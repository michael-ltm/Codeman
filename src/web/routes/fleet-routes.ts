/**
 * @fileoverview Fleet dashboard REST routes (Task 12).
 *
 * Exposes the FleetCentralController (Task 8) and DeviceRegistry (Task 4) as a
 * REST surface for the dashboard frontend (Task 13/14): aggregate state,
 * device pairing, per-device session lifecycle (create/stop/read-terminal),
 * and an HTTP input fallback (Task 17) for remote tabs when the browser
 * terminal WebSocket (Task 11) is down.
 * All responses go through the app-wide `{success,data}` envelope (the
 * preSerialization hook installed in server.ts) — handlers here return plain
 * data or throw structured `{statusCode, body}` errors, the same convention
 * route-helpers.ts's `parseBody`/`findSessionOrFail` use and
 * route-error-handler.ts renders (mirrors session-routes.ts).
 *
 * `POST /api/fleet/pair` is exempted from Basic Auth/cookie auth (Task 9's
 * bypass in middleware/auth.ts) — a headless node agent has no session to
 * present. Every other route here requires the normal dashboard auth, checked
 * upstream by the global auth middleware before these handlers ever run.
 *
 * Error mapping for the session-lifecycle calls (POST/DELETE .../sessions,
 * GET .../terminal, POST .../input):
 * - Device unknown or offline (`!controller.getHandle(id) || !controller.isOnline(id)`)
 *   → 409 'Device is offline'
 * - Remote RPC timeout (central-controller.ts's `RemoteDeviceHandle.request`
 *   rejects with exactly this message) → 504
 * - CLI/backend unavailable on the target device (message contains
 *   'unavailable', e.g. 'tmux unavailable') → 422, message passed through
 *   verbatim
 * - Any other thrown error that already carries `statusCode`/`body` (e.g. a
 *   LOCAL device's createSessionCore — see route-helpers.ts's `throwApiError`)
 *   is rethrown as-is so its original status/body reaches the client unchanged
 * - Body validation failures → 400 (`parseBody`)
 * - POST .../input additionally 404s when `!controller.hasSession(deviceId, sessionId)`
 *   (unknown session on an otherwise-online device)
 *
 * Key export: registerFleetRoutes
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { FleetCentralController } from '../../fleet/central-controller.js';
import type { DeviceRegistry } from '../../fleet/device-registry.js';
import { CreateFleetSessionRequestSchema, FleetDeviceJoinInfoSchema } from '../../fleet/protocol.js';
import { parseBody } from '../route-helpers.js';
import { ApiErrorCode, createErrorResponse, getErrorMessage } from '../../types.js';
import { MAX_INPUT_LENGTH } from '../../config/terminal-limits.js';

const PairRequestSchema = z.object({
  code: z.string().min(1),
  device: FleetDeviceJoinInfoSchema,
});

/**
 * Body for the fleet input fallback (POST .../input) — a subset of
 * SessionInputWithLimitSchema (schemas.ts, the LOCAL session input route)
 * shaped for the remote path: no `useMux` (fleet nodes always deliver via
 * their own mux path), but the same reliable-delivery `seq`/`clientId` pair
 * and the same MAX_INPUT_LENGTH bound. Dedup for these two fields happens
 * NODE-side (the target device's own Session.shouldApplyInput) — this route
 * is a fire-and-forget forward, same as the WS 'i' frame path.
 */
const FleetSessionInputSchema = z.object({
  input: z.string().min(1).max(MAX_INPUT_LENGTH),
  seq: z.number().int().nonnegative().optional(),
  clientId: z.string().max(128).optional(),
});

const DEVICE_OFFLINE_MESSAGE = 'Device is offline';
const NODE_TIMEOUT_MESSAGE = 'Fleet node request timed out';
const UNKNOWN_SESSION_MESSAGE = 'Unknown session';

/**
 * Throws a structured `{statusCode, body}` error at an explicit HTTP status —
 * same rendering convention as route-helpers.ts's `parseBody`/`findSessionOrFail`
 * (route-error-handler.ts renders it verbatim), but for caller-chosen statuses
 * (504/422/409) that don't map 1:1 from an `ApiErrorCode` via
 * `httpStatusForErrorCode`.
 */
function throwFleetError(statusCode: number, code: ApiErrorCode, message: string): never {
  throw Object.assign(new Error(message), {
    statusCode,
    body: createErrorResponse(code, message),
  });
}

export function registerFleetRoutes(
  app: FastifyInstance,
  deps: { controller: FleetCentralController; registry: DeviceRegistry }
): void {
  const { controller, registry } = deps;

  app.get('/api/fleet', async () => controller.getDashboardState());

  // Sort order is already handled by controller.getDashboardState(); this
  // just narrows the aggregate state to the two lists the device-list view needs.
  app.get('/api/fleet/devices', async () => {
    const { devices, sessions } = await controller.getDashboardState();
    return { devices, sessions };
  });

  app.post('/api/fleet/pairing-codes', async (req) => {
    const { code, expiresAt } = registry.createPairingCode();
    const origin = `${req.protocol}://${req.headers.host}`;
    return { code, expiresAt, joinCommand: `codeman node join ${origin} --code ${code}` };
  });

  // Auth-exempt (Task 9's bypass in middleware/auth.ts) — validate the body
  // with zod BEFORE touching the registry, so a malformed request never
  // consumes/invalidates a one-time pairing code.
  app.post('/api/fleet/pair', async (req) => {
    const { code, device } = parseBody(PairRequestSchema, req.body);
    try {
      return registry.consumePairingCode(code, device);
    } catch (err) {
      throwFleetError(400, ApiErrorCode.INVALID_INPUT, getErrorMessage(err));
    }
  });

  app.post<{ Params: { deviceId: string } }>('/api/fleet/devices/:deviceId/sessions', async (req) => {
    const { deviceId } = req.params;
    const body = parseBody(CreateFleetSessionRequestSchema, req.body);
    const handle = controller.getHandle(deviceId);
    if (!handle || !controller.isOnline(deviceId)) {
      throwFleetError(409, ApiErrorCode.CONFLICT, DEVICE_OFFLINE_MESSAGE);
    }
    try {
      return await handle.createSession(body);
    } catch (err) {
      // A local device's createSessionCore (route-helpers.ts) already throws a
      // structured {statusCode,body} error (e.g. 422 for an unavailable CLI,
      // 400 for a bad workingDir) — pass it through unchanged.
      if (err && typeof err === 'object' && 'statusCode' in err) throw err;
      const message = getErrorMessage(err);
      if (message === NODE_TIMEOUT_MESSAGE) {
        throwFleetError(504, ApiErrorCode.OPERATION_FAILED, message);
      }
      if (/unavailable/i.test(message)) {
        throwFleetError(422, ApiErrorCode.OPERATION_FAILED, message);
      }
      throw err;
    }
  });

  app.delete<{ Params: { deviceId: string; sessionId: string } }>(
    '/api/fleet/devices/:deviceId/sessions/:sessionId',
    async (req) => {
      const { deviceId, sessionId } = req.params;
      const handle = controller.getHandle(deviceId);
      if (!handle || !controller.isOnline(deviceId)) {
        throwFleetError(409, ApiErrorCode.CONFLICT, DEVICE_OFFLINE_MESSAGE);
      }
      await handle.stopSession(sessionId);
      return { ok: true };
    }
  );

  app.get<{ Params: { deviceId: string; sessionId: string } }>(
    '/api/fleet/devices/:deviceId/sessions/:sessionId/terminal',
    async (req) => {
      const { deviceId, sessionId } = req.params;
      const handle = controller.getHandle(deviceId);
      if (!handle) return { buffer: '' };
      try {
        return { buffer: await handle.getTerminalBuffer(sessionId) };
      } catch {
        // The node can't provide a replayable buffer (e.g. no tmux capture
        // support) — the browser terminal WS (Task 11) fills in live output
        // from here on, so an empty buffer is a safe fallback, not an error.
        return { buffer: '' };
      }
    }
  );

  // HTTP fallback for reliable input delivery on remote tabs (Task 17/18):
  // the primary path is the WS 'i' frame; this exists for when the socket is
  // down. Fire-and-forget like that frame path — dedup for (clientId, seq)
  // happens NODE-side via the target session's Session.shouldApplyInput, not
  // here, so a 2xx here is just "forwarded", not "applied".
  app.post<{ Params: { deviceId: string; sessionId: string } }>(
    '/api/fleet/devices/:deviceId/sessions/:sessionId/input',
    async (req) => {
      const { deviceId, sessionId } = req.params;
      const { input, seq, clientId } = parseBody(FleetSessionInputSchema, req.body);
      const handle = controller.getHandle(deviceId);
      if (!handle || !controller.isOnline(deviceId)) {
        throwFleetError(409, ApiErrorCode.CONFLICT, DEVICE_OFFLINE_MESSAGE);
      }
      if (!controller.hasSession(deviceId, sessionId)) {
        throwFleetError(404, ApiErrorCode.NOT_FOUND, UNKNOWN_SESSION_MESSAGE);
      }
      handle.writeInput(sessionId, input, seq, clientId);
      return {};
    }
  );
}
