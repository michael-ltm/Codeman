/**
 * @fileoverview Authentication and security middleware.
 *
 * Extracted from server.ts setupRoutes() — handles:
 * - HTTP Basic Auth with session cookies
 * - Rate limiting (per-IP failure tracking)
 * - Security headers (CSP, X-Frame-Options, HSTS)
 * - CORS (localhost only)
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { StaleExpirationMap } from '../../utils/index.js';
import type { AuthSessionRecord } from '../ports/auth-port.js';
import {
  AUTH_SESSION_TTL_MS,
  MAX_AUTH_SESSIONS,
  AUTH_FAILURE_MAX,
  AUTH_FAILURE_WINDOW_MS,
} from '../../config/auth-config.js';

// Auth session cookie name
export const AUTH_COOKIE_NAME = 'codeman_session';

/** State returned from registerAuthMiddleware for cleanup in server stop() */
interface AuthState {
  authSessions: StaleExpirationMap<string, AuthSessionRecord> | null;
  authFailures: StaleExpirationMap<string, number> | null;
  qrAuthFailures: StaleExpirationMap<string, number> | null;
}

/**
 * Register HTTP Basic Auth middleware with session cookies and rate limiting.
 * Only active when CODEMAN_PASSWORD is set.
 *
 * @returns AuthState for lifecycle management (dispose on server stop)
 */
export function registerAuthMiddleware(app: FastifyInstance, https: boolean): AuthState {
  const state: AuthState = {
    authSessions: null,
    authFailures: null,
    qrAuthFailures: null,
  };

  const authPassword = process.env.CODEMAN_PASSWORD;
  if (!authPassword) return state;

  const authUsername = process.env.CODEMAN_USERNAME || 'admin';
  const expectedHeader = 'Basic ' + Buffer.from(`${authUsername}:${authPassword}`).toString('base64');

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

  const authSessions = state.authSessions;
  const authFailures = state.authFailures;

  function sendAuthRateLimit(reply: FastifyReply, clientIp: string): void {
    const remainingMs = authFailures.getRemainingTtl(clientIp) ?? AUTH_FAILURE_WINDOW_MS;
    const retryAfterSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
    reply.header('Retry-After', String(retryAfterSeconds));
    reply.code(429).send('Too Many Requests — try again later');
  }

  app.addHook('onRequest', (req, reply, done) => {
    // Hook events come from local Claude Code hooks (curl from localhost) — no auth headers available.
    // Safe: validated by HookEventSchema, only triggers broadcasts.
    // Security: restrict bypass to localhost only — prevents forged hook events via tunnel/LAN.
    if (req.url === '/api/hook-event' && req.method === 'POST') {
      const ip = req.ip;
      if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
        done();
        return;
      }
      // Non-localhost hook requests fall through to normal auth
    }

    // QR auth path — handled by the route itself (token validation + rate limiting)
    if (req.url?.startsWith('/q/')) {
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

    // Check Basic Auth header (timing-safe comparison to prevent side-channel attacks)
    const auth = req.headers.authorization;
    const authBuf = Buffer.from(auth ?? '');
    const expectedBuf = Buffer.from(expectedHeader);
    if (authBuf.length === expectedBuf.length && timingSafeEqual(authBuf, expectedBuf)) {
      // Issue session token cookie so browser doesn't need to re-send credentials
      const token = randomBytes(32).toString('hex');

      // Evict oldest if at capacity (prevent unbounded growth)
      if (authSessions.size >= MAX_AUTH_SESSIONS) {
        const oldestKey = authSessions.keys().next().value;
        if (oldestKey !== undefined) authSessions.delete(oldestKey);
      }

      authSessions.set(token, {
        ip: clientIp,
        ua: req.headers['user-agent'] ?? '',
        createdAt: Date.now(),
        method: 'basic',
      });

      // Reset failure count on successful auth
      authFailures.delete(clientIp);

      reply.setCookie(AUTH_COOKIE_NAME, token, {
        httpOnly: true,
        secure: https,
        sameSite: 'lax',
        maxAge: AUTH_SESSION_TTL_MS / 1000, // seconds
        path: '/',
      });
      done();
      return;
    }

    // Rate limit only requests that failed to authenticate on this attempt.
    const failures = authFailures.get(clientIp) ?? 0;
    if (failures >= AUTH_FAILURE_MAX) {
      sendAuthRateLimit(reply, clientIp);
      return;
    }

    // Auth failed — track failure count
    authFailures.set(clientIp, failures + 1);

    reply.header('WWW-Authenticate', 'Basic realm="Codeman"');
    reply.code(401).send('Unauthorized');
  });

  return state;
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
  const workerSrc = gesture ? "; worker-src 'self' blob:" : '';
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
