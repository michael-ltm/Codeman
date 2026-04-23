/**
 * @fileoverview Auto-compact and auto-clear automation for Session.
 *
 * Monitors token counts and triggers /compact or /clear commands when
 * configurable thresholds are reached. Waits for Claude to be idle
 * before sending commands, with retry logic and mutual exclusion
 * (compact and clear never run simultaneously).
 *
 * @module session-auto-ops
 */

import { EventEmitter } from 'node:events';

// ============================================================================
// Timing Constants
// ============================================================================

/** Delay for auto-compact/clear retry attempts (2 seconds) */
const AUTO_RETRY_DELAY_MS = 2000;

/** Delay for auto-compact/clear initial check (1 second) */
const AUTO_INITIAL_DELAY_MS = 1000;

/** Cooldown after compact completes before re-enabling (10 seconds) */
const COMPACT_COOLDOWN_MS = 10000;

/** Cooldown after clear completes before re-enabling (5 seconds) */
const CLEAR_COOLDOWN_MS = 5000;

/**
 * Executes an action when the session becomes idle, retrying if currently working.
 *
 * @param action - The async action to execute once idle
 * @param isActive - Returns whether this operation is still active (not cancelled)
 * @param isWorking - Returns whether the session is currently working
 * @param isStopped - Returns whether the session has been stopped
 * @param retryMs - Delay between retry attempts when working
 * @param cooldownMs - Delay after action completes before calling onCooldownDone
 * @param setTimer - Stores the timer reference for cleanup
 * @param onCooldownDone - Called after cooldown to reset state
 */
async function executeWhenIdle(
  action: () => Promise<void>,
  isActive: () => boolean,
  isWorking: () => boolean,
  isStopped: () => boolean,
  retryMs: number,
  cooldownMs: number,
  setTimer: (timer: NodeJS.Timeout | null) => void,
  onCooldownDone: () => void
): Promise<void> {
  if (isStopped()) return;
  if (!isActive()) return;

  if (!isWorking()) {
    if (isStopped()) return;

    await action();

    if (!isStopped()) {
      setTimer(
        setTimeout(() => {
          if (isStopped()) return;
          setTimer(null);
          onCooldownDone();
        }, cooldownMs)
      );
    }
  } else {
    if (!isStopped()) {
      setTimer(
        setTimeout(
          () => executeWhenIdle(action, isActive, isWorking, isStopped, retryMs, cooldownMs, setTimer, onCooldownDone),
          retryMs
        )
      );
    }
  }
}

/** Minimum valid threshold for auto-clear/compact (1000 tokens) */
const MIN_AUTO_THRESHOLD = 1000;

/** Maximum valid threshold for auto-clear/compact (500k tokens) */
const MAX_AUTO_THRESHOLD = 500_000;

/** Default auto-clear threshold when invalid value provided */
const DEFAULT_AUTO_CLEAR_THRESHOLD = 140_000;

/** Default auto-compact threshold when invalid value provided */
const DEFAULT_AUTO_COMPACT_THRESHOLD = 110_000;

/**
 * Callbacks required by SessionAutoOps to interact with the parent Session.
 */
interface AutoOpsCallbacks {
  /** Send a command via the terminal multiplexer */
  writeCommand: (command: string) => Promise<boolean>;
  /** Check if Claude is currently working */
  isWorking: () => boolean;
  /** Check if the session has been stopped */
  isStopped: () => boolean;
  /** Get current total token count (input + output) */
  getTotalTokens: () => number;
  /** Get session ID for logging */
  getSessionId: () => string;
}

/**
 * Events emitted by SessionAutoOps.
 */

/**
 * Manages auto-compact and auto-clear automation for a Session.
 *
 * When enabled, monitors token counts after each update and triggers
 * /compact or /clear commands when thresholds are exceeded. Ensures
 * mutual exclusion between compact and clear operations.
 */
export class SessionAutoOps extends EventEmitter {
  // Auto-compact state
  private _autoCompactThreshold: number;
  private _autoCompactEnabled: boolean = false;
  private _autoCompactPrompt: string = '';
  private _isCompacting: boolean = false;
  private _autoCompactTimer: NodeJS.Timeout | null = null;

  // Auto-clear state
  private _autoClearThreshold: number;
  private _autoClearEnabled: boolean = false;
  private _isClearing: boolean = false;
  private _autoClearTimer: NodeJS.Timeout | null = null;

  private readonly callbacks: AutoOpsCallbacks;

  constructor(callbacks: AutoOpsCallbacks, config?: { compactThreshold?: number; clearThreshold?: number }) {
    super();
    this.callbacks = callbacks;
    this._autoCompactThreshold = config?.compactThreshold ?? DEFAULT_AUTO_COMPACT_THRESHOLD;
    this._autoClearThreshold = config?.clearThreshold ?? DEFAULT_AUTO_CLEAR_THRESHOLD;
  }

  // ============================================================================
  // Auto-compact getters/setters
  // ============================================================================

  get autoCompactThreshold(): number {
    return this._autoCompactThreshold;
  }

  get autoCompactEnabled(): boolean {
    return this._autoCompactEnabled;
  }

  get autoCompactPrompt(): string {
    return this._autoCompactPrompt;
  }

  get isCompacting(): boolean {
    return this._isCompacting;
  }

  setAutoCompact(enabled: boolean, threshold?: number, prompt?: string): void {
    this._autoCompactEnabled = enabled;
    if (threshold !== undefined) {
      if (threshold < MIN_AUTO_THRESHOLD || threshold > MAX_AUTO_THRESHOLD) {
        console.warn(
          `[SessionAutoOps ${this.callbacks.getSessionId()}] Invalid autoCompact threshold ${threshold}, must be between ${MIN_AUTO_THRESHOLD} and ${MAX_AUTO_THRESHOLD}. Using default ${DEFAULT_AUTO_COMPACT_THRESHOLD}.`
        );
        this._autoCompactThreshold = DEFAULT_AUTO_COMPACT_THRESHOLD;
      } else {
        this._autoCompactThreshold = threshold;
      }
    }
    if (prompt !== undefined) {
      this._autoCompactPrompt = prompt;
    }
  }

  // ============================================================================
  // Auto-clear getters/setters
  // ============================================================================

  get autoClearThreshold(): number {
    return this._autoClearThreshold;
  }

  get autoClearEnabled(): boolean {
    return this._autoClearEnabled;
  }

  get isClearing(): boolean {
    return this._isClearing;
  }

  setAutoClear(enabled: boolean, threshold?: number): void {
    this._autoClearEnabled = enabled;
    if (threshold !== undefined) {
      if (threshold < MIN_AUTO_THRESHOLD || threshold > MAX_AUTO_THRESHOLD) {
        console.warn(
          `[SessionAutoOps ${this.callbacks.getSessionId()}] Invalid autoClear threshold ${threshold}, must be between ${MIN_AUTO_THRESHOLD} and ${MAX_AUTO_THRESHOLD}. Using default ${DEFAULT_AUTO_CLEAR_THRESHOLD}.`
        );
        this._autoClearThreshold = DEFAULT_AUTO_CLEAR_THRESHOLD;
      } else {
        this._autoClearThreshold = threshold;
      }
    }
  }

  // ============================================================================
  // Threshold checks
  // ============================================================================

  /**
   * Check if auto-compact should be triggered based on current token count.
   * Called after token count updates.
   */
  checkAutoCompact(): void {
    if (this.callbacks.isStopped()) return;
    if (!this._autoCompactEnabled || this._isCompacting || this._isClearing) return;

    const totalTokens = this.callbacks.getTotalTokens();
    if (totalTokens >= this._autoCompactThreshold) {
      this._isCompacting = true;
      console.log(
        `[SessionAutoOps] Auto-compact triggered: ${totalTokens} tokens >= ${this._autoCompactThreshold} threshold`
      );

      const action = async () => {
        const compactCmd = this._autoCompactPrompt ? `/compact ${this._autoCompactPrompt}\r` : '/compact\r';
        await this.callbacks.writeCommand(compactCmd);
        this.emit('autoCompact', {
          tokens: totalTokens,
          threshold: this._autoCompactThreshold,
          prompt: this._autoCompactPrompt || undefined,
        });
      };

      if (!this.callbacks.isStopped()) {
        this._autoCompactTimer = setTimeout(
          () =>
            executeWhenIdle(
              action,
              () => this._isCompacting,
              () => this.callbacks.isWorking(),
              () => this.callbacks.isStopped(),
              AUTO_RETRY_DELAY_MS,
              COMPACT_COOLDOWN_MS,
              (timer) => {
                this._autoCompactTimer = timer;
              },
              () => {
                this._isCompacting = false;
              }
            ),
          AUTO_INITIAL_DELAY_MS
        );
      }
    }
  }

  /**
   * Check if auto-clear should be triggered based on current token count.
   * Called after token count updates.
   */
  checkAutoClear(): void {
    if (this.callbacks.isStopped()) return;
    if (!this._autoClearEnabled || this._isClearing || this._isCompacting) return;

    const totalTokens = this.callbacks.getTotalTokens();
    if (totalTokens >= this._autoClearThreshold) {
      this._isClearing = true;
      console.log(
        `[SessionAutoOps] Auto-clear triggered: ${totalTokens} tokens >= ${this._autoClearThreshold} threshold`
      );

      const action = async () => {
        await this.callbacks.writeCommand('/clear\r');
        this.emit('autoClear', { tokens: totalTokens, threshold: this._autoClearThreshold });
      };

      if (!this.callbacks.isStopped()) {
        this._autoClearTimer = setTimeout(
          () =>
            executeWhenIdle(
              action,
              () => this._isClearing,
              () => this.callbacks.isWorking(),
              () => this.callbacks.isStopped(),
              AUTO_RETRY_DELAY_MS,
              CLEAR_COOLDOWN_MS,
              (timer) => {
                this._autoClearTimer = timer;
              },
              () => {
                this._isClearing = false;
              }
            ),
          AUTO_INITIAL_DELAY_MS
        );
      }
    }
  }

  // ============================================================================
  // Cleanup
  // ============================================================================

  /**
   * Clear all timers and reset state. Called when the session stops.
   */
  destroy(): void {
    if (this._autoCompactTimer) {
      clearTimeout(this._autoCompactTimer);
      this._autoCompactTimer = null;
    }
    this._isCompacting = false;

    if (this._autoClearTimer) {
      clearTimeout(this._autoClearTimer);
      this._autoClearTimer = null;
    }
    this._isClearing = false;
  }
}
