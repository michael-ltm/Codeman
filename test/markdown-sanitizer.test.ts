// @vitest-environment jsdom
/**
 * COD-56 — markdown HTML sanitizer (mXSS hardening).
 *
 * The response viewer / attachment preview render agent- and transcript-derived markdown to
 * HTML via `marked` (raw-HTML passthrough) and assign the result with innerHTML. The HTML must
 * be sanitized first. The original sanitizer (`_sanitizeHtml` in app.js) was a hand-rolled
 * DENYLIST and is mXSS-prone — it never stripped `svg`/`math`/`style`, so foreign-namespace and
 * CSS vectors survived.
 *
 * This suite drives the EXACT shipping artifacts under jsdom:
 *   - src/web/public/vendor/dompurify.min.js   (the vendored sanitizer)
 *   - src/web/public/sanitize-html.js          (our allowlist config wired to DOMPurify)
 *
 * It feeds a corpus of mXSS payloads (svg/math/style/namespace-confusion/event-handler) and
 * asserts the output carries NO script-executing constructs, and that legitimate
 * markdown-rendered HTML survives unchanged.
 *
 * RED demonstration: a faithful re-implementation of the OLD denylist sanitizer is included and
 * asserted to LET payloads through — the gap this fix closes.
 *
 * No port / server needed; pure DOM logic in jsdom.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const publicDir = join(process.cwd(), 'src/web/public');

/** Build the SHIPPING sanitizer the way the browser does: vendored DOMPurify + sanitize-html.js,
 *  both evaluated inside the (jsdom) window so DOMPurify binds to a real DOM. */
function loadShippingSanitizer(): (html: string) => string {
  const win = window as unknown as Record<string, unknown>;
  // Evaluate the vendored UMD in the jsdom global context (mirrors <script src=vendor/...>).
  const dompurifySrc = readFileSync(join(publicDir, 'vendor/dompurify.min.js'), 'utf8');
  // sanitize-html.js is a classic script that reads global DOMPurify and sets sanitizeMarkdownHtml.
  const sanitizeSrc = readFileSync(join(publicDir, 'sanitize-html.js'), 'utf8');
  // jsdom's window is the global in this vitest environment; eval the classic scripts into it
  // so DOMPurify and sanitizeMarkdownHtml bind to the jsdom window exactly as in the browser.
  (0, eval)(dompurifySrc);
  (0, eval)(sanitizeSrc);
  const fn = win.sanitizeMarkdownHtml as ((html: string) => string) | undefined;
  if (typeof fn !== 'function') throw new Error('sanitizeMarkdownHtml not wired');
  return fn;
}

/** Faithful copy of the OLD denylist _sanitizeHtml (app.js pre-COD-56) — used only to prove RED. */
function oldDenylistSanitize(html: string): string {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const frag = tpl.content;
  for (const el of frag.querySelectorAll('script, iframe, object, embed, form, base, meta, link, style')) {
    el.remove();
  }
  for (const el of frag.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
      } else if (['href', 'src', 'action', 'xlink:href', 'formaction'].includes(name)) {
        const val = attr.value.replace(/\s/g, '').toLowerCase();
        if (val.startsWith('javascript:') || val.startsWith('vbscript:') || val.startsWith('data:text/html')) {
          el.removeAttribute(attr.name);
        }
      }
    }
  }
  const div = document.createElement('div');
  div.appendChild(frag);
  return div.innerHTML;
}

// mXSS / XSS payloads. Each must be neutralized by the shipping sanitizer.
const PAYLOADS: { name: string; html: string }[] = [
  { name: 'img onerror', html: '<img src=x onerror=alert(1)>' },
  { name: 'svg onload', html: '<svg onload=alert(1)></svg>' },
  { name: 'svg/script', html: '<svg><script>alert(1)</script></svg>' },
  { name: 'svg/style mXSS', html: '<svg><style><img src=x onerror=alert(1)></style></svg>' },
  {
    name: 'math/mtext/table namespace confusion',
    html: '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)></style></table></mtext></math>',
  },
  { name: 'style attr expression', html: '<div style="width:expression(alert(1))">x</div>' },
  { name: 'style attr url(javascript:)', html: '<div style="background:url(javascript:alert(1))">x</div>' },
  { name: 'style element', html: '<style>body{background:url("javascript:alert(1)")}</style>' },
  { name: 'noscript wrap', html: '<noscript><p title="</noscript><img src=x onerror=alert(1)>">' },
  { name: 'a javascript: href', html: '<a href="javascript:alert(1)">x</a>' },
  { name: 'iframe srcdoc', html: '<iframe srcdoc="<img src=x onerror=alert(1)>"></iframe>' },
  {
    name: 'foreignObject mXSS',
    html: '<svg><foreignObject><iframe src="javascript:alert(1)"></iframe></foreignObject></svg>',
  },
  { name: 'details ontoggle', html: '<details open ontoggle=alert(1)>x</details>' },
  { name: 'object data', html: '<object data="javascript:alert(1)"></object>' },
];

function assertNeutralized(out: string, label: string) {
  const lower = out.toLowerCase();
  expect(lower, `${label}: no <script>`).not.toContain('<script');
  expect(lower, `${label}: no <svg>`).not.toContain('<svg');
  expect(lower, `${label}: no <math>`).not.toContain('<math');
  expect(lower, `${label}: no <iframe>`).not.toContain('<iframe');
  expect(lower, `${label}: no <object>`).not.toContain('<object');
  expect(lower, `${label}: no <style>`).not.toContain('<style');
  expect(lower, `${label}: no onerror`).not.toContain('onerror');
  expect(lower, `${label}: no onload`).not.toContain('onload');
  expect(lower, `${label}: no ontoggle`).not.toContain('ontoggle');
  expect(lower, `${label}: no style= attr`).not.toMatch(/\sstyle\s*=/);
  expect(lower, `${label}: no javascript: scheme`).not.toContain('javascript:');
  expect(lower, `${label}: no expression(`).not.toContain('expression(');
}

describe('COD-56 markdown sanitizer (DOMPurify allowlist)', () => {
  let sanitize: (html: string) => string;

  beforeAll(() => {
    sanitize = loadShippingSanitizer();
  });

  describe('mXSS / XSS payloads are neutralized', () => {
    for (const { name, html } of PAYLOADS) {
      it(`blocks: ${name}`, () => {
        assertNeutralized(sanitize(html), name);
      });
    }
  });

  describe('legitimate markdown-rendered HTML survives', () => {
    it('keeps bold, links, lists, code, headings, tables, safe images', () => {
      const md =
        '<h2>Title</h2>' +
        '<p><strong>bold</strong> and <em>em</em> and <a href="https://example.com">link</a></p>' +
        '<ul><li>one</li><li>two</li></ul>' +
        '<pre><code class="language-js">const x = 1;</code></pre>' +
        '<blockquote><p>quote</p></blockquote>' +
        '<table><thead><tr><th>h</th></tr></thead><tbody><tr><td>c</td></tr></tbody></table>' +
        '<img src="https://example.com/a.png" alt="pic">';
      const out = sanitize(md);
      expect(out).toContain('<strong>bold</strong>');
      expect(out).toContain('<em>em</em>');
      expect(out).toContain('href="https://example.com"');
      expect(out).toContain('<li>one</li>');
      expect(out).toContain('<code class="language-js">const x = 1;</code>');
      expect(out).toContain('<blockquote>');
      expect(out).toContain('<th>h</th>');
      expect(out).toContain('<td>c</td>');
      expect(out).toContain('src="https://example.com/a.png"');
      expect(out).toContain('alt="pic"');
    });

    it('preserves a relative/inline image src and code fences', () => {
      const out = sanitize('<p>see <code>code</code></p><img src="/local/path.png" alt="x">');
      expect(out).toContain('<code>code</code>');
      expect(out).toContain('src="/local/path.png"');
    });
  });

  // RED EVIDENCE: the OLD denylist let mXSS through. This documents the gap the fix closes;
  // it asserts the OLD logic FAILS to neutralize at least the svg/math/style vectors.
  describe('RED: the old denylist sanitizer was bypassable', () => {
    it('old code leaves <svg> / <math> roots in the output', () => {
      // svg/math were never in the denylist tag set -> they survive (mXSS foreign namespace).
      const svgOut = oldDenylistSanitize('<svg><circle></circle></svg>').toLowerCase();
      const mathOut = oldDenylistSanitize('<math><mtext>x</mtext></math>').toLowerCase();
      expect(svgOut).toContain('<svg');
      expect(mathOut).toContain('<math');
    });

    it('old code leaves a CSS-vector style attribute in the output', () => {
      const out = oldDenylistSanitize('<div style="background:url(javascript:alert(1))">x</div>').toLowerCase();
      // style attributes were never stripped by the denylist.
      expect(out).toMatch(/\sstyle\s*=/);
      expect(out).toContain('javascript:');
    });

    it('NEW code closes those same gaps', () => {
      expect(sanitize('<svg><circle></circle></svg>').toLowerCase()).not.toContain('<svg');
      expect(sanitize('<math><mtext>x</mtext></math>').toLowerCase()).not.toContain('<math');
      const out = sanitize('<div style="background:url(javascript:alert(1))">x</div>').toLowerCase();
      expect(out).not.toMatch(/\sstyle\s*=/);
      expect(out).not.toContain('javascript:');
    });
  });
});
