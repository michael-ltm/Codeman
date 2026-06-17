/**
 * @fileoverview CJK IME input for xterm.js terminal.
 *
 * Always-visible textarea below the terminal (in index.html).
 * The browser handles IME composition natively — we just read
 * textarea.value and send it to PTY.
 * While this textarea has focus, window.cjkActive = true blocks xterm's onData.
 * Arrow keys and function keys are forwarded to PTY directly.
 *
 * ## Android IME challenge
 *
 * Android virtual keyboards (WeChat, Sogou, Gboard in Chinese mode) use
 * composition for EVERYTHING — including English prediction and punctuation.
 * This means compositionstart fires even for English text, and compositionend
 * may not fire until the user explicitly confirms (space, candidate tap).
 *
 * During composition, all input events are ignored — only compositionend
 * triggers a flush (CJK candidate selection).
 *
 * ## iOS dictation challenge (WebKit Bug 261764)
 *
 * iOS/iPadOS voice dictation does NOT fire composition events. Text arrives
 * as bare input events with isComposing === false. Dictation refinement is
 * a delete→reinsert cycle (deleteContentBackward + insertReplacementText),
 * all within a few ms. Flushing on every input event would send irrevocable
 * provisional text to the PTY, causing duplication when the IME replaces it.
 *
 * Solution: outside composition, flush is DEBOUNCED (200ms). The entire
 * delete→reinsert cycle collapses into one flush of the final textarea value.
 * Keyboard typing of single printable characters still goes through the
 * keydown handler (immediate, no debounce).
 *
 * ## Phantom character for Android backspace
 *
 * Android virtual keyboards don't generate key-repeat keydown events for held
 * keys. When the textarea is empty, backspace produces no `input` event either
 * (nothing to delete). We keep a zero-width space (U+200B) "phantom" in the
 * textarea at all times. Backspace deletes the phantom → `input` fires with
 * `deleteContentBackward` → we send \x7f to PTY and restore the phantom.
 * Long-press backspace generates rapid deleteContentBackward events, each
 * handled the same way — giving continuous deletion at the keyboard's native
 * repeat rate.
 *
 * @dependency index.html (#cjkInput textarea)
 * @globals {object} CjkInput — window.cjkActive (boolean) signals app.js to block xterm onData
 * @loadorder 5.5 of 15 — loaded after keyboard-accessory.js, before app.js
 */

// eslint-disable-next-line no-unused-vars
const CjkInput = (() => {
  let _textarea = null;
  let _send = null;
  let _initialized = false;
  let _composing = false;
  let _flushTimer = null;
  let _dictationActive = false;
  let _dictationDecayTimer = null;
  let _keydownSentAt = 0;
  const _listeners = {};

  const PHANTOM = '​';

  // Two-tier debounce for non-composition input:
  // - KEYBOARD: short debounce (third-party IMEs like Doubao may not fire
  //   composition events even for keyboard CJK typing)
  // - DICTATION: long debounce (iOS voice dictation sends delete→reinsert
  //   refinement cycles without composition events — WebKit Bug 261764)
  //
  // Dictation is detected by deleteContentBackward on non-empty text or
  // insertReplacementText — signals that the IME is rewriting provisional
  // text. Once detected, dictation mode persists for 3s (covers multi-word
  // dictation with natural pauses between words).
  const DEBOUNCE_KEYBOARD_MS = 150;
  const DEBOUNCE_DICTATION_MS = 1500;
  const DICTATION_DECAY_MS = 3000;

  const PASSTHROUGH_KEYS = {
    ArrowUp:    '\x1b[A',
    ArrowDown:  '\x1b[B',
    ArrowLeft:  '\x1b[D',
    ArrowRight: '\x1b[C',
    Home:       '\x1b[H',
    End:        '\x1b[F',
    Tab:        '\t',
  };

  const CTRL_KEYS = {
    c: '\x03', d: '\x04', l: '\x0c', z: '\x1a', a: '\x01', e: '\x05',
  };

  function _strip(str) {
    return str.replace(/​/g, '');
  }

  function _resetToPhantom() {
    _textarea.value = PHANTOM;
    _textarea.setSelectionRange(1, 1);
  }

  function _isEffectivelyEmpty() {
    return !_strip(_textarea.value);
  }

  /** Flush textarea: send real text to PTY and reset to phantom */
  function _flush() {
    const val = _strip(_textarea.value);
    if (val) {
      _send(val);
    }
    _resetToPhantom();
  }

  /** Cancel any pending debounced flush */
  function _cancelDebouncedFlush() {
    if (_flushTimer) {
      clearTimeout(_flushTimer);
      _flushTimer = null;
    }
  }

  /** Mark that dictation rewriting is in progress */
  function _enterDictationMode() {
    _dictationActive = true;
    clearTimeout(_dictationDecayTimer);
    _dictationDecayTimer = setTimeout(() => {
      _dictationActive = false;
      _dictationDecayTimer = null;
    }, DICTATION_DECAY_MS);
  }

  /** Schedule a flush after input settles */
  function _debouncedFlush() {
    _cancelDebouncedFlush();
    const delay = _dictationActive ? DEBOUNCE_DICTATION_MS : DEBOUNCE_KEYBOARD_MS;
    _flushTimer = setTimeout(() => {
      _flushTimer = null;
      _flush();
    }, delay);
  }

  return {
    init({ send }) {
      if (_initialized) this.destroy();

      _send = send;
      _composing = false;
      _flushTimer = null;
      _textarea = document.getElementById('cjkInput');
      if (!_textarea) return this;

      _resetToPhantom();

      _listeners.mousedown = (e) => { e.stopPropagation(); };
      _listeners.focus = () => {
        window.cjkActive = true;
        if (!_textarea.value) _resetToPhantom();
      };
      _listeners.blur = () => {
        // Keep cjkActive while CJK input is visible — iOS dictation and system
        // UI may steal focus temporarily, and clearing the flag during that
        // window lets xterm's onData process duplicated input.
        if (!_textarea.classList.contains('cjk-input-visible')) {
          window.cjkActive = false;
        }
      };
      _textarea.addEventListener('mousedown', _listeners.mousedown);
      _textarea.addEventListener('focus', _listeners.focus);
      _textarea.addEventListener('blur', _listeners.blur);

      // ── Composition tracking (keyboard IME — works for CJK typing) ──
      _listeners.compositionstart = () => {
        _composing = true;
        _cancelDebouncedFlush();
        // Leave textarea.value untouched — programmatic changes during
        // compositionstart cancel the IME composition on iOS Safari.
      };
      _listeners.compositionend = () => {
        _composing = false;
        _cancelDebouncedFlush();
        // Defer flush: some Android IMEs haven't committed text to textarea
        // when compositionend fires. setTimeout(0) ensures we read the final value.
        setTimeout(_flush, 0);
      };
      _textarea.addEventListener('compositionstart', _listeners.compositionstart);
      _textarea.addEventListener('compositionend', _listeners.compositionend);

      // ── Keydown: special keys work REGARDLESS of composition state ──
      _listeners.keydown = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          _composing = false;
          _cancelDebouncedFlush();
          const val = _strip(_textarea.value);
          if (val) {
            _send(val + '\r');
          } else {
            _send('\r');
          }
          _resetToPhantom();
          return;
        }

        if (e.key === 'Escape') {
          e.preventDefault();
          _composing = false;
          _cancelDebouncedFlush();
          _resetToPhantom();
          return;
        }

        if (e.ctrlKey && CTRL_KEYS[e.key]) {
          e.preventDefault();
          _send(CTRL_KEYS[e.key]);
          return;
        }

        // Below: only when NOT composing (composing keystrokes belong to IME)
        if (_composing) return;

        // Backspace: forward to PTY when no real text in textarea
        if (e.key === 'Backspace' && _isEffectivelyEmpty()) {
          e.preventDefault();
          _send('\x7f');
          _resetToPhantom();
          return;
        }

        // Arrow/function keys: forward to PTY when no real text
        if (PASSTHROUGH_KEYS[e.key] && _isEffectivelyEmpty()) {
          e.preventDefault();
          _send(PASSTHROUGH_KEYS[e.key]);
          return;
        }

        // Single printable character: send immediately to PTY.
        // Third-party IMEs on iOS may ignore preventDefault, so the char
        // still enters the textarea and fires an input event — _keydownSentAt
        // tells the input handler to skip that echo.
        if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && _isEffectivelyEmpty()) {
          e.preventDefault();
          _send(e.key);
          _keydownSentAt = performance.now();
          _resetToPhantom();
          return;
        }
      };
      _textarea.addEventListener('keydown', _listeners.keydown);

      // ── Input event: primary path for virtual keyboards + dictation ──
      _listeners.input = (e) => {
        // ── Backspace / delete detection ──
        if (e.inputType === 'deleteContentBackward' || e.inputType === 'deleteWordBackward') {
          if (_composing) return;
          if (_isEffectivelyEmpty()) {
            _cancelDebouncedFlush();
            _send('\x7f');
            _resetToPhantom();
            return;
          }
          // Delete on non-empty text outside composition = dictation rewrite.
          // The IME is revising provisional text — switch to long debounce.
          _enterDictationMode();
          if (!_textarea.value.startsWith(PHANTOM)) {
            _textarea.value = PHANTOM + _textarea.value;
            _textarea.setSelectionRange(1, 1);
          }
          _debouncedFlush();
          return;
        }

        // insertReplacementText = dictation/autocorrect refinement
        if (e.inputType === 'insertReplacementText') {
          _enterDictationMode();
          _debouncedFlush();
          return;
        }

        if (_composing) return;

        // Keydown handler already sent this character — just clear the
        // textarea echo that the IME inserted despite preventDefault.
        if (performance.now() - _keydownSentAt < 100) {
          _resetToPhantom();
          return;
        }

        // Outside composition: keyboard typing or voice dictation.
        // If dictation mode was detected (delete/replacement events seen
        // recently), use long debounce. Otherwise short debounce for keyboard.
        _debouncedFlush();
      };
      _textarea.addEventListener('input', _listeners.input);

      _initialized = true;
      return this;
    },

    destroy() {
      _cancelDebouncedFlush();
      clearTimeout(_dictationDecayTimer);
      _dictationActive = false;
      if (_textarea) {
        for (const [event, handler] of Object.entries(_listeners)) {
          if (handler) _textarea.removeEventListener(event, handler);
        }
      }
      window.cjkActive = false;
      _composing = false;
      for (const key of Object.keys(_listeners)) delete _listeners[key];
      _initialized = false;
    },

    get element() { return _textarea; },
  };
})();
