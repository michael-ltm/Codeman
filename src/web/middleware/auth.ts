/**
 * @fileoverview Authentication and security middleware.
 *
 * Extracted from server.ts setupRoutes() — handles:
 * - HTTP Basic Auth with session cookies
 * - Rate limiting (per-IP failure tracking)
 * - Security headers (CSP, X-Frame-Options, HSTS)
 * - CORS (localhost only)
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { StaleExpirationMap } from '../../utils/index.js';
import type { AuthSessionRecord } from '../ports/auth-port.js';
import { isAllowedRequestHost, isAllowedRequestOrigin, type HostPolicy } from '../network-auth-policy.js';
import {
  AUTH_SESSION_TTL_MS,
  MAX_AUTH_SESSIONS,
  AUTH_FAILURE_MAX,
  AUTH_FAILURE_WINDOW_MS,
  FLEET_PAIR_RATE_LIMIT_MAX,
  FLEET_PAIR_RATE_LIMIT_WINDOW_MS,
} from '../../config/auth-config.js';
import { getHookSecret, HOOK_SECRET_HEADER } from '../../config/hook-secret.js';
import {
  verifyCredentials,
  isPasswordConfigured,
  getConfiguredUsername,
  setPassword,
} from '../../config/auth-store.js';
import { renderLoginHtml } from '../login-page.js';
import { AuthLoginSchema, ChangePasswordSchema } from '../schemas.js';
import { createErrorResponse, ApiErrorCode } from '../../types/api.js';

/** Static-asset file extensions that should get a 401 (never the login page). */
const ASSET_EXT_RE =
  /\.(?:js|mjs|css|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf|eot|wasm|task|json|txt|xml|webmanifest)$/i;

/**
 * Is this a top-level browser PAGE navigation (→ serve the login page) rather
 * than an `/api/*` call or a static-asset fetch (→ 401 JSON)? A navigation is a
 * GET whose `Accept` includes `text/html`, whose path is not under `/api/`, and
 * whose path does not end in a known asset extension. Non-browser clients (curl,
 * which sends a wildcard Accept) fall through to the 401 JSON branch.
 */
function isPageNavigationRequest(req: FastifyRequest): boolean {
  if (req.method !== 'GET') return false;
  const path = (req.url.split('?')[0] || '').toLowerCase();
  if (path.startsWith('/api/')) return false;
  if (ASSET_EXT_RE.test(path)) return false;
  const accept = req.headers.accept ?? '';
  return accept.includes('text/html');
}

// Auth session cookie name
export const AUTH_COOKIE_NAME = 'codeman_session';

/** State returned from registerAuthMiddleware for cleanup in server stop() */
interface AuthState {
  authSessions: StaleExpirationMap<string, AuthSessionRecord> | null;
  authFailures: StaleExpirationMap<string, number> | null;
  qrAuthFailures: StaleExpirationMap<string, number> | null;
  hookSecretFailures: StaleExpirationMap<string, number> | null;
  fleetPairAttempts: StaleExpirationMap<string, number> | null;
}

/**
 * Register HTTP Basic Auth middleware with session cookies and rate limiting.
 * Only active when CODEMAN_PASSWORD is set.
 *
 * The `/api/hook-event` + `/api/status-telemetry` localhost bypass requires the
 * shared hook secret unconditionally (COD-91) — see the onRequest hook below.
 *
 * @returns AuthState for lifecycle management (dispose on server stop)
 */
export function registerAuthMiddleware(app: FastifyInstance, https: boolean): AuthState {
  const state: AuthState = {
    authSessions: null,
    authFailures: null,
    qrAuthFailures: null,
    hookSecretFailures: null,
    fleetPairAttempts: null,
  };

  // Auth activates when a password is configured EITHER via `auth.json` (the
  // custom-login credential store) OR the legacy `CODEMAN_PASSWORD` env var. A
  // passwordless loopback node has neither → early-return (no gate, no login
  // page) exactly as before. Credential verification below is delegated to
  // `auth-store.verifyCredentials` (auth.json wins over env, constant-time).
  if (!isPasswordConfigured()) return state;

  // Session token store — active sessions extend TTL on access
  state.authSessions = new StaleExpirationMap<string, AuthSessionRecord>({
    ttlMs: AUTH_SESSION_TTL_MS,
    refreshOnGet: true,
  });

  // Failure counter per IP — decay naturally after 15 minutes
  state.authFailures = new StaleExpirationMap<string, number>({
    ttlMs: AUTH_FAILURE_WINDOW_MS,
    refreshOnGet: false,
  });

  // Separate QR auth failure counter — independent from Basic Auth failures
  state.qrAuthFailures = new StaleExpirationMap<string, number>({
    ttlMs: AUTH_FAILURE_WINDOW_MS,
    refreshOnGet: false,
  });

  // Separate hook-secret failure counter (COD-54). MUST NOT share authFailures:
  // legacy (pre-secret) hook configs fire constantly from 127.0.0.1, and counting
  // their 401s against the shared bucket would 429 every cookie-less request from
  // loopback — locking out the Basic-Auth login path (and, through a tunnel, every
  // client, since tunneled traffic also arrives as 127.0.0.1).
  state.hookSecretFailures = new StaleExpirationMap<string, number>({
    ttlMs: AUTH_FAILURE_WINDOW_MS,
    refreshOnGet: false,
  });

  // Fleet pairing attempt counter per IP — independent bucket, 1-minute window
  // (see the /api/fleet/pair bypass below). Counts every attempt (not just
  // failures): the route itself validates the code, this middleware only caps
  // the attempt rate.
  state.fleetPairAttempts = new StaleExpirationMap<string, number>({
    ttlMs: FLEET_PAIR_RATE_LIMIT_WINDOW_MS,
    refreshOnGet: false,
  });

  const authSessions = state.authSessions;
  const authFailures = state.authFailures;
  const hookSecretFailures = state.hookSecretFailures;
  const fleetPairAttempts = state.fleetPairAttempts;

  function sendAuthRateLimit(
    reply: FastifyReply,
    clientIp: string,
    failures: StaleExpirationMap<string, number> = authFailures
  ): void {
    const remainingMs = failures.getRemainingTtl(clientIp) ?? AUTH_FAILURE_WINDOW_MS;
    const retryAfterSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
    reply.header('Retry-After', String(retryAfterSeconds));
    reply.code(429).send('Too Many Requests — try again later');
  }

  /**
   * Issue a fresh session-token cookie. Single source of the cookie-issuing
   * logic, reused by the Basic-Auth success path AND the POST /api/auth/login
   * route so both mint identical 24h cookies. Evicts the oldest session when at
   * capacity to keep the store bounded.
   */
  function issueSessionCookie(req: FastifyRequest, reply: FastifyReply, method: AuthSessionRecord['method']): void {
    const token = randomBytes(32).toString('hex');
    if (authSessions.size >= MAX_AUTH_SESSIONS) {
      const oldestKey = authSessions.keys().next().value;
      if (oldestKey !== undefined) authSessions.delete(oldestKey);
    }
    authSessions.set(token, {
      ip: req.ip,
      ua: req.headers['user-agent'] ?? '',
      createdAt: Date.now(),
      method,
    });
    reply.setCookie(AUTH_COOKIE_NAME, token, {
      httpOnly: true,
      secure: https,
      sameSite: 'lax',
      maxAge: AUTH_SESSION_TTL_MS / 1000, // seconds
      path: '/',
    });
  }

  app.addHook('onRequest', (req, reply, done) => {
    // Hook events + statusline telemetry come from local Claude Code (curl from
    // localhost) — no Basic-Auth credentials available. Validated downstream by
    // HookEventSchema / StatusTelemetrySchema. Same loopback+hook-secret gate.
    //
    // COD-54: the bare localhost bypass is unsafe while a tunnel is running, because
    // `cloudflared --url http://127.0.0.1:port` proxies internet traffic INTO the
    // loopback origin, so a tunneled request arrives with req.ip === 127.0.0.1 and
    // would pass. COD-91: require the shared hook secret on the loopback bypass
    // UNCONDITIONALLY (not just while the managed tunnel is up). Codeman can't detect
    // a user's own loopback reverse proxy (their own `cloudflared --url`, `tailscale
    // serve`, nginx → 127.0.0.1), so tunnel-gating left that path with the unsafe plain
    // bypass. Managed-session hooks always present the secret (X-Codeman-Hook-Secret,
    // from $CODEMAN_HOOK_SECRET_FILE — generated for every instance), so requiring it
    // always closes the gap without breaking the legitimate hook channel.
    if ((req.url === '/api/hook-event' || req.url === '/api/status-telemetry') && req.method === 'POST') {
      const ip = req.ip;
      const isLoopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
      if (isLoopback) {
        // Always require the shared secret (constant-time compare).
        const presented = Buffer.from(req.headers[HOOK_SECRET_HEADER.toLowerCase()]?.toString() ?? '');
        const expected = Buffer.from(getHookSecret());
        if (presented.length === expected.length && timingSafeEqual(presented, expected)) {
          done();
          return;
        }
        // Wrong/absent secret — rate-limit per IP in the DEDICATED hook bucket
        // (never authFailures, which would lock out the login path).
        const hookIp = req.ip;
        const hookFailures = hookSecretFailures.get(hookIp) ?? 0;
        if (hookFailures >= AUTH_FAILURE_MAX) {
          sendAuthRateLimit(reply, hookIp, hookSecretFailures);
          return;
        }
        hookSecretFailures.set(hookIp, hookFailures + 1);
        reply.code(401).send('Unauthorized: hook secret required');
        return;
      }
      // Non-localhost hook requests fall through to normal auth
    }

    // Fleet device pairing: the pairing code IS the credential (single-use,
    // 10-minute TTL, consumed by DeviceRegistry.consumePairingCode inside the
    // route itself) — a brand-new node has no dashboard password to present, so
    // Basic Auth would just be friction with nothing to check. Guarded by its
    // own per-IP rate limit (independent bucket from authFailures) so a missing
    // or guessed code can't be brute-forced.
    if (req.url === '/api/fleet/pair' && req.method === 'POST') {
      const ip = req.ip;
      const attempts = fleetPairAttempts.get(ip) ?? 0;
      if (attempts >= FLEET_PAIR_RATE_LIMIT_MAX) {
        sendAuthRateLimit(reply, ip, fleetPairAttempts);
        return;
      }
      fleetPairAttempts.set(ip, attempts + 1);
      done();
      return;
    }

    // Fleet node WebSocket: authenticated by a per-device Bearer token
    // (DeviceRegistry.authenticate), checked by the route itself — see
    // fleet-ws-routes.ts. A headless node agent has no cookie jar and no Basic
    // Auth credentials to present. Nothing else under /api/fleet/* or
    // /ws/fleet/devices/* is exempted — those still require Basic Auth/cookie
    // like every other dashboard route.
    if (req.url === '/ws/fleet/node' && req.method === 'GET') {
      done();
      return;
    }

    // QR auth path — handled by the route itself (token validation + rate limiting)
    if (req.url?.startsWith('/q/')) {
      done();
      return;
    }

    // Custom login-page endpoint — auth-EXEMPT (it ESTABLISHES a session). The
    // route handler below runs verifyCredentials + the SAME per-IP failure
    // limiter as the Basic path, so brute force is throttled identically. Only
    // /api/auth/login is exempt here: /api/auth/change-password MUST be
    // authenticated and so is deliberately NOT bypassed (it flows through the
    // gate below like any other route).
    if (req.url === '/api/auth/login' && req.method === 'POST') {
      done();
      return;
    }

    const clientIp = req.ip;

    // Check session cookie first (avoids re-sending credentials on every request)
    // Use get() instead of has() so refreshOnGet extends the TTL on active sessions
    const sessionToken = req.cookies[AUTH_COOKIE_NAME];
    if (sessionToken && authSessions.get(sessionToken) !== undefined) {
      done();
      return;
    }

    // Check Basic Auth header. Decode `Basic <base64(user:pass)>` and verify via
    // the credential store (auth.json wins over env; the compare is constant-time
    // by construction inside auth-store). curl -u and Claude Code hooks keep
    // working — they send the header proactively and never relied on the removed
    // WWW-Authenticate challenge.
    const auth = req.headers.authorization;
    const hadBasicCredentials = typeof auth === 'string' && auth.startsWith('Basic ');
    if (hadBasicCredentials) {
      const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      const sep = decoded.indexOf(':');
      const user = sep === -1 ? decoded : decoded.slice(0, sep);
      const pass = sep === -1 ? '' : decoded.slice(sep + 1);
      if (verifyCredentials(user, pass)) {
        issueSessionCookie(req, reply, 'basic');
        authFailures.delete(clientIp); // reset failure count on success
        done();
        return;
      }
    }

    // Not authenticated. Rate-limit ONLY when a credential was PRESENTED and
    // rejected (a brute-force vector). A plain unauthenticated navigation (no
    // cookie, no Basic header) must NOT count — otherwise repeatedly loading the
    // login page would self-lock the IP before the user ever submits.
    if (hadBasicCredentials) {
      const failures = authFailures.get(clientIp) ?? 0;
      if (failures >= AUTH_FAILURE_MAX) {
        sendAuthRateLimit(reply, clientIp);
        return;
      }
      authFailures.set(clientIp, failures + 1);
    }

    // Unauthenticated request routing (NO WWW-Authenticate → no native browser
    // prompt): a browser PAGE navigation gets the self-contained login page
    // (200); an /api/* call or asset fetch gets a 401 JSON envelope so the
    // frontend can react without navigating.
    if (isPageNavigationRequest(req)) {
      reply
        .code(200)
        .header('Cache-Control', 'no-cache')
        .header('X-Frame-Options', 'SAMEORIGIN')
        .header('X-Content-Type-Options', 'nosniff')
        .type('text/html; charset=utf-8')
        .send(renderLoginHtml());
      return;
    }
    reply.code(401).send(createErrorResponse(ApiErrorCode.UNAUTHORIZED, 'Unauthorized'));
  });

  // ── Custom login-page auth routes ─────────────────────────────────────────
  // Registered here (not in a route module) so they reuse the private
  // authSessions/authFailures maps + issueSessionCookie/sendAuthRateLimit
  // helpers directly — no duplication, no extra port plumbing. Only reachable
  // when auth is active (we return early above when no password is configured).

  // POST /api/auth/login — auth-exempt (bypassed in the onRequest hook above).
  app.post('/api/auth/login', (req, reply) => {
    const clientIp = req.ip;
    // Same per-IP lockout the Basic path uses (shared authFailures bucket).
    const failures = authFailures.get(clientIp) ?? 0;
    if (failures >= AUTH_FAILURE_MAX) {
      sendAuthRateLimit(reply, clientIp);
      return;
    }
    const parsed = AuthLoginSchema.safeParse(req.body);
    const ok = parsed.success && verifyCredentials(parsed.data.username, parsed.data.password);
    if (!ok) {
      authFailures.set(clientIp, failures + 1);
      reply.code(401).send(createErrorResponse(ApiErrorCode.UNAUTHORIZED, 'Invalid credentials'));
      return;
    }
    issueSessionCookie(req, reply, 'login');
    authFailures.delete(clientIp); // reset on success
    reply.send({ success: true });
  });

  // POST /api/auth/change-password — NOT auth-exempt: reaches here only once the
  // middleware gate above has authenticated the caller. Re-verifies the current
  // password (getConfiguredUsername gives the active user) before rotating.
  app.post('/api/auth/change-password', (req, reply) => {
    const parsed = ChangePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid request'));
      return;
    }
    const { currentPassword, newPassword } = parsed.data;
    if (newPassword.length < 8) {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'New password too short'));
      return;
    }
    const username = getConfiguredUsername();
    if (!verifyCredentials(username, currentPassword)) {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Current password incorrect'));
      return;
    }
    setPassword(username, newPassword);
    reply.send({ success: true });
  });

  return state;
}

/** Methods that don't change server state and so skip the cross-site Origin check. */
const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Register the anti-DNS-rebinding Host allowlist + cross-site (CSRF) Origin guard.
 *
 * This protects the API even on the default no-password install, where there is no
 * cookie/credential to gate on. It must be registered BEFORE the auth middleware so
 * forged cross-site or DNS-rebound requests are rejected up front. `getPolicy` is
 * evaluated per request so a tunnel started at runtime is reflected immediately.
 *
 * - Every request: the `Host` header must be in the allowlist (blocks DNS rebinding,
 *   where a custom domain is rebound to 127.0.0.1 but still sends its own name).
 * - State-changing methods: the `Origin` (when the client sends one — i.e. a browser)
 *   must be same-site (blocks cross-site CSRF, including the text/plain simple-request
 *   trick). Non-browser clients (curl, Claude Code hooks) omit Origin and pass.
 *
 * WebSocket upgrades are validated separately in the ws route handler.
 */
export function registerHostGuard(app: FastifyInstance, getPolicy: () => HostPolicy): void {
  app.addHook('onRequest', (req, reply, done) => {
    const policy = getPolicy();
    if (!isAllowedRequestHost(req.headers.host, policy)) {
      reply.code(403).send('Forbidden: host not allowed');
      return;
    }
    if (!SAFE_HTTP_METHODS.has(req.method) && !isAllowedRequestOrigin(req.headers.origin, policy)) {
      reply.code(403).send('Forbidden: cross-site request blocked');
      return;
    }
    done();
  });
}

/**
 * Register security headers and CORS middleware on every response.
 */
export function registerSecurityHeaders(app: FastifyInstance, https: boolean): void {
  // Gesture-control overlay (opt-in via CODEMAN_GESTURE=1) runs MediaPipe, which
  // needs WebAssembly eval (script-src) and blob workers (worker-src). Its wasm
  // runtime + model are self-hosted under /gesture/ (same-origin, covered by
  // 'self'), so no CDN connect-src entries are needed. OFF by default so the
  // production CSP is byte-for-byte unchanged.
  const gesture = process.env.CODEMAN_GESTURE === '1';
  const scriptSrc =
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net" + (gesture ? " 'wasm-unsafe-eval'" : '');
  const connectSrc = "connect-src 'self' wss://api.deepgram.com";
  // blob: workers are needed unconditionally: terminal-ui's _safeYield tick
  // worker (throttling escape) is created from a Blob URL. Without this, every
  // page load logs a CSP violation and the worker leg of _safeYield is dead.
  // Risk is minimal — only same-origin scripts (already governed by script-src)
  // can construct blob workers.
  const workerSrc = "; worker-src 'self' blob:";
  const csp =
    `default-src 'self'; ${scriptSrc}; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; ` +
    `img-src 'self' data: blob:; ${connectSrc}; font-src 'self' https://cdn.jsdelivr.net; frame-ancestors 'self'${workerSrc}`;

  app.addHook('onRequest', (req, reply, done) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'SAMEORIGIN');
    reply.header('Content-Security-Policy', csp);
    if (https) {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    // CORS: restrict to same-origin (localhost) only
    const origin = req.headers.origin;
    if (origin) {
      try {
        const url = new URL(origin);
        if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1') {
          reply.header('Access-Control-Allow-Origin', origin);
          reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
          reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
          reply.header('Access-Control-Max-Age', '86400');
        }
      } catch {
        // Invalid origin header — do not set CORS headers
      }
    }

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      reply.code(204).send();
      done();
      return;
    }

    done();
  });
}
