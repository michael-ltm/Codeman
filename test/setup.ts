/**
 * @fileoverview Global test setup for Codeman tests
 *
 * SAFETY: TmuxManager has built-in test mode detection
 * (via process.env.VITEST) that makes ALL shell commands no-ops.
 * This means tests CANNOT kill, create, or interact with real tmux
 * sessions regardless of what the test code does.
 *
 * This setup file strips shell-level auth configuration that can leak from a
 * running Codeman instance, then handles mock/timer cleanup between tests.
 */

import { afterEach, vi } from 'vitest';

delete process.env.CODEMAN_PASSWORD;
delete process.env.CODEMAN_USERNAME;

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});
