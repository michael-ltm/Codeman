// Port 3208 - Mobile header button visibility (real-browser E2E).
//
// Companion to the CI static guard (test/mobile-header-buttons-policy.test.ts).
// This one renders the real app in an emulated phone vs. a desktop-class tablet
// and asserts the ACTUAL computed visibility — catching CSS/layout regressions
// the static parser can't see. Regression history: the COD-39 attachments button
// (and earlier the plan-usage chip) shipped visible on the cramped phone header.
import { describe, it, beforeAll, afterAll } from 'vitest';
import type { WebServer } from '../../src/web/server.js';
import { createTestServer, stopTestServer } from './helpers/server.js';
import { createDevicePage, closeAllBrowsers } from './helpers/browser.js';
import { assertHidden, assertVisible } from './helpers/assertions.js';
import { REPRESENTATIVE_DEVICES } from './devices.js';
import { PORTS, WAIT } from './helpers/constants.js';

const PORT = PORTS.HEADER_BUTTONS;
const BASE_URL = `http://localhost:${PORT}`;

// Secondary header buttons that must NOT clutter the minimal phone header
// (settings/case controls live in the mobile toolbar instead).
const PHONE_HIDDEN = [
  '#attachmentsHistoryBtn', // COD-39 — the reported regression
  '.btn-icon-header.btn-settings',
  '.btn-icon-header.btn-lifecycle-log',
];

describe('Mobile header button visibility (E2E)', () => {
  let server: WebServer;

  beforeAll(async () => {
    server = await createTestServer(PORT);
  });

  afterAll(async () => {
    await closeAllBrowsers();
    await stopTestServer(server);
  });

  it('hides secondary header buttons on a standard phone (iPhone 14 Pro, 393px)', async () => {
    const { page } = await createDevicePage(REPRESENTATIVE_DEVICES['standard-phone'], BASE_URL);
    await page.waitForTimeout(WAIT.PAGE_SETTLE);
    for (const sel of PHONE_HIDDEN) {
      await assertHidden(page, sel);
    }
  });

  it('keeps the attachments button visible on a desktop-class tablet', async () => {
    // assertHidden also passes when an element is ABSENT, so prove the selector is
    // real by asserting the same button IS visible where the phone rule doesn't apply.
    const { page } = await createDevicePage(REPRESENTATIVE_DEVICES['large-tablet'], BASE_URL);
    await page.waitForTimeout(WAIT.PAGE_SETTLE);
    await assertVisible(page, '#attachmentsHistoryBtn');
  });
});
