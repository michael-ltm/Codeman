/**
 * Defaults, bounds, and resolution for terminal history retention.
 *
 * Centralizes the terminal scrollback, tmux history-limit, and server PTY buffer
 * byte caps that were previously scattered as hardcoded literals. Each value is
 * overridable (env var or the settings object) and clamped to a sane range via
 * resolveTerminalHistoryConfig(). Defaults intentionally match the prior
 * hardcoded values, so introducing this module is behavior-neutral.
 */

export const DEFAULT_TERMINAL_SCROLLBACK_LINES = 50_000;
export const DEFAULT_TMUX_HISTORY_LIMIT = 50_000;
export const DEFAULT_TERMINAL_BUFFER_MAX_BYTES =
  parseInt(process.env.CODEMAN_MAX_TERMINAL_BUFFER || '', 10) || 2 * 1024 * 1024;
export const DEFAULT_TERMINAL_BUFFER_TRIM_BYTES =
  parseInt(process.env.CODEMAN_TRIM_TERMINAL_TO || '', 10) || 1.5 * 1024 * 1024;

export const MIN_TERMINAL_SCROLLBACK_LINES = 1_000;
export const MAX_TERMINAL_SCROLLBACK_LINES = 1_000_000;
export const MIN_TERMINAL_BUFFER_BYTES = 1024 * 1024;
export const MAX_TERMINAL_BUFFER_BYTES = 128 * 1024 * 1024;

export interface TerminalHistoryConfig {
  terminalScrollbackLines: number;
  tmuxHistoryLimit: number;
  terminalBufferMaxBytes: number;
  terminalBufferTrimBytes: number;
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

export function resolveTerminalHistoryConfig(settings: Record<string, unknown> = {}): TerminalHistoryConfig {
  const terminalBufferMaxBytes = boundedInt(
    settings.terminalBufferMaxBytes,
    DEFAULT_TERMINAL_BUFFER_MAX_BYTES,
    MIN_TERMINAL_BUFFER_BYTES,
    MAX_TERMINAL_BUFFER_BYTES
  );
  const terminalBufferTrimBytes = boundedInt(
    settings.terminalBufferTrimBytes,
    Math.min(DEFAULT_TERMINAL_BUFFER_TRIM_BYTES, terminalBufferMaxBytes),
    MIN_TERMINAL_BUFFER_BYTES,
    terminalBufferMaxBytes
  );

  return {
    terminalScrollbackLines: boundedInt(
      settings.terminalScrollbackLines,
      DEFAULT_TERMINAL_SCROLLBACK_LINES,
      MIN_TERMINAL_SCROLLBACK_LINES,
      MAX_TERMINAL_SCROLLBACK_LINES
    ),
    tmuxHistoryLimit: boundedInt(
      settings.tmuxHistoryLimit,
      DEFAULT_TMUX_HISTORY_LIMIT,
      MIN_TERMINAL_SCROLLBACK_LINES,
      MAX_TERMINAL_SCROLLBACK_LINES
    ),
    terminalBufferMaxBytes,
    terminalBufferTrimBytes,
  };
}
