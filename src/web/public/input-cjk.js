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
 * We use InputEvent.inputType to distinguish:
 * - `insertCompositionText`: tentative text, may change (CJK candidates, pinyin)
 * - `insertText`: final committed text (confirmed word, punctuation, space)
 *
 * During composition, `insertText` events are flushed immediately (punctuation,
 * English words confirmed by IME). `insertCompositionText` waits for
 * compositionend (CJK candidate selection).
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
  let _terminalContainer = null;
  let _xtermTextarea = null;
  let _send = null;
  let _initialized = false;
  let _composing = false;
  const _listeners = {};

  // Zero-width space: always present in textarea so Android backspace has
  // something to delete, triggering the `input` event we need to detect it.
  const PHANTOM = '\u200B';

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

  /** Strip phantom characters from a string */
  function _strip(str) {
    return str.replace(/\u200B/g, '');
  }

  /** Reset textarea to phantom-only state with cursor at end */
  function _resetToPhantom() {
    _textarea.value = PHANTOM;
    _textarea.setSelectionRange(1, 1);
  }

  function _isMobileComposer() {
    return !!(
      _textarea &&
      typeof MobileDetection !== 'undefined' &&
      MobileDetection.isTouchDevice() &&
      _textarea.classList.contains('cjk-input-visible')
    );
  }

  function _resetInput() {
    if (_isMobileComposer()) {
      _textarea.value = '';
    } else {
      _resetToPhantom();
    }
  }

  /** Check if textarea contains only phantom(s) or is empty — no real user text */
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

  return {
    init({ send }) {
      if (_initialized) this.destroy();

      _send = send;
      _composing = false;
      _textarea = document.getElementById('cjkInput');
      if (!_textarea) return this;
      _terminalContainer = document.getElementById('terminalContainer');

      // Seed the phantom character for the hidden/immediate CJK path.
      _resetInput();

      _listeners.mousedown = (e) => { e.stopPropagation(); };
      _listeners.focus = () => {
        window.cjkActive = true;
        if (_isMobileComposer() && _textarea.value === PHANTOM) {
          _textarea.value = '';
          return;
        }
        // Restore phantom if textarea was emptied while blurred
        if (!_textarea.value && !_isMobileComposer()) _resetToPhantom();
      };
      _listeners.blur = () => { window.cjkActive = false; };
      _textarea.addEventListener('mousedown', _listeners.mousedown);
      _textarea.addEventListener('focus', _listeners.focus);
      _textarea.addEventListener('blur', _listeners.blur);

      _listeners.xtermFocusRedirect = () => {
        if (!_isMobileComposer()) return;
        _textarea.focus();
      };
      if (_terminalContainer) {
        _xtermTextarea = _terminalContainer.querySelector('.xterm-helper-textarea');
        if (_xtermTextarea) {
          _xtermTextarea.addEventListener('focus', _listeners.xtermFocusRedirect, { capture: true });
        }
      }

      // ── Composition tracking ──
      _listeners.compositionstart = () => {
        _composing = true;
        if (_isMobileComposer()) {
          if (_textarea.value === PHANTOM) _textarea.value = '';
          return;
        }
        // Clear phantom so IME sees a clean textarea — some IMEs include
        // existing text in the composition region which would corrupt input.
        if (_textarea.value === PHANTOM) {
          _textarea.value = '';
        }
      };
      _listeners.compositionend = () => {
        _composing = false;
        if (_isMobileComposer()) return;
        // Defer flush: some Android IMEs haven't committed text to textarea
        // when compositionend fires. setTimeout(0) ensures we read the final value.
        setTimeout(_flush, 0);
      };
      _textarea.addEventListener('compositionstart', _listeners.compositionstart);
      _textarea.addEventListener('compositionend', _listeners.compositionend);

      // ── Keydown: special keys work REGARDLESS of composition state ──
      _listeners.keydown = (e) => {
        // Enter: flush accumulated text (or bare Enter if empty).
        // No isComposing guard — Android IMEs set isComposing=true for English
        // prediction, but Enter should ALWAYS send. We preventDefault to stop
        // the IME from also handling Enter (which could double-send or do nothing).
        if (e.key === 'Enter') {
          e.preventDefault();
          _composing = false;
          const val = _strip(_textarea.value);
          if (val) {
            _send(val + '\r');
          } else {
            _send('\r');
          }
          _resetInput();
          return;
        }

        // Escape: clear textarea (always works)
        if (e.key === 'Escape') {
          e.preventDefault();
          _composing = false;
          _resetInput();
          return;
        }

        // Ctrl combos: forward to PTY (always works)
        if (e.ctrlKey && CTRL_KEYS[e.key]) {
          e.preventDefault();
          _send(CTRL_KEYS[e.key]);
          return;
        }

        // Below: only when NOT composing (composing keystrokes belong to IME)
        if (_composing) return;

        if (_isMobileComposer()) {
          if (e.key === 'Backspace' && _isEffectivelyEmpty()) {
            e.preventDefault();
            _send('\x7f');
            return;
          }
          if (PASSTHROUGH_KEYS[e.key] && _isEffectivelyEmpty()) {
            e.preventDefault();
            _send(PASSTHROUGH_KEYS[e.key]);
          }
          return;
        }

        // Backspace: forward to PTY when no real text in textarea
        // (Desktop path — Android uses the input event + phantom approach)
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

        // Single printable character: send immediately to PTY
        // (Desktop keyboards with physical keys — Android sends 'Unidentified')
        if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && _isEffectivelyEmpty()) {
          e.preventDefault();
          _send(e.key);
          return;
        }
      };
      _textarea.addEventListener('keydown', _listeners.keydown);

      // ── Input event: the primary path for Android virtual keyboards ──
      // Android sends keyCode 229 + key "Unidentified" for virtual key presses,
      // making keydown unreliable. input fires AFTER character insertion and
      // carries inputType which tells us whether the text is final or tentative.
      _listeners.input = (e) => {
        if (_isMobileComposer()) {
          if (_textarea.value.includes(PHANTOM)) {
            _textarea.value = _strip(_textarea.value);
          }
          return;
        }

        // ── Backspace / delete detection ──
        // Android long-press backspace generates rapid deleteContentBackward events.
        // The phantom character ensures the textarea is never truly empty, so each
        // press/repeat fires an input event that we can catch here.
        if (e.inputType === 'deleteContentBackward' || e.inputType === 'deleteWordBackward') {
          if (_isEffectivelyEmpty()) {
            // No real text left — forward backspace to PTY
            _send('\x7f');
            _resetToPhantom();
            return;
          }
          // User is editing their own text in the textarea — let it be.
          // Ensure phantom is still present for the NEXT backspace.
          if (!_textarea.value.startsWith(PHANTOM)) {
            _textarea.value = PHANTOM + _textarea.value;
            _textarea.setSelectionRange(1, 1);
          }
          return;
        }

        if (_composing) {
          // insertText during composition = IME committed final text
          // (e.g., punctuation key inserts 。directly, or IME confirms a word).
          // Flush immediately — this text won't change.
          if (e.inputType === 'insertText') {
            _flush();
            return;
          }
          // insertCompositionText = IME is still working (pinyin, candidates,
          // English prediction). Wait for compositionend to flush.
          return;
        }
        // Outside composition: send immediately
        _flush();
      };
      _textarea.addEventListener('input', _listeners.input);

      _initialized = true;
      return this;
    },

    destroy() {
      if (_textarea) {
        for (const [event, handler] of Object.entries(_listeners)) {
          if (handler) _textarea.removeEventListener(event, handler);
        }
      }
      if (_xtermTextarea && _listeners.xtermFocusRedirect) {
        _xtermTextarea.removeEventListener('focus', _listeners.xtermFocusRedirect, { capture: true });
      }
      window.cjkActive = false;
      _composing = false;
      _terminalContainer = null;
      _xtermTextarea = null;
      for (const key of Object.keys(_listeners)) delete _listeners[key];
      _initialized = false;
    },

    get element() { return _textarea; },
  };
})();
