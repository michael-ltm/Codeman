/**
 * @fileoverview Authentication, rate limiting, and hook security constants.
 *
 * Controls auth session lifecycle, brute-force protection,
 * and Claude Code hook timeouts.
 *
 * @module config/auth-config
 */

// ============================================================================
// Session Cookies
// ============================================================================

/** Auth session cookie TTL — matches autonomous run length (ms) */
export const AUTH_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** Max concurrent auth sessions per server */
export const MAX_AUTH_SESSIONS = 100;

// ============================================================================
// Rate Limiting
// ============================================================================

/** Max failed auth attempts per IP before 429 rejection */
export const AUTH_FAILURE_MAX = 10;

/** Failed auth attempt tracking window (ms) */
export const AUTH_FAILURE_WINDOW_MS = 15 * 60 * 1000;

/**
 * Max `POST /api/fleet/pair` attempts per IP per window. The pairing code IS the
 * credential (Basic Auth is bypassed for this route — see auth.ts), so this is
 * the only thing standing between a caller and brute-forcing an 8-char code.
 */
export const FLEET_PAIR_RATE_LIMIT_MAX = 10;

/** `POST /api/fleet/pair` rate limit window (ms). */
export const FLEET_PAIR_RATE_LIMIT_WINDOW_MS = 60 * 1000;

// ============================================================================
// Hooks
// ============================================================================

/** Timeout for Claude Code hook curl commands (ms) */
export const HOOK_TIMEOUT_MS = 10000;
