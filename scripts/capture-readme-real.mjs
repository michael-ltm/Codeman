#!/usr/bin/env node
/**
 * capture-readme-real.mjs
 *
 * Captures README desktop scenes (multi-session dashboard, monitor, subagent
 * windows) from a REAL Codeman instance — intended to run against an ISOLATED
 * dev/beta instance (CODEMAN_INSTANCE=beta on :5000) seeded from prod's settings,
 * NOT prod itself (never touch prod's live sessions).
 *
 * Reuses the high-quality capture recipe proven in capture-real-overview.mjs:
 *   - DSF=2 + ?nowebgl  → crisp retina at the TRUE font size (WebGL doubles
 *     glyphs under DSF=2; the DOM renderer respects devicePixelRatio).
 *   - per-device localStorage seeding so the capture matches a real device.
 *
 *   SCENE=dashboard|monitor|subagent|all  BASE=http://localhost:5000 \
 *     OUT=screenshots-readme-real/desktop  node scripts/capture-readme-real.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { join } from 'path';

const BASE = process.env.BASE || 'http://localhost:5000';
const OUT = process.env.OUT || 'screenshots-readme-real/desktop';
const SKIN = process.env.SKIN || 'daylight-blue';
const SCENE = process.env.SCENE || 'all';
const FONT = Math.max(10, Math.min(24, Number(process.env.FONT || 13)));
const VIEWPORT = { width: Number(process.env.VW || 1280), height: Number(process.env.VH || 720) };
const DSF = Number(process.env.DSF || 2);
const PLAN_USAGE = process.env.PLAN_USAGE !== '0';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const url = (extra = '') => {
  const sep = BASE.includes('?') ? '&' : '?';
  const params = [];
  if (DSF > 1) params.push('nowebgl'); // DOM renderer → correct font size at DSF>1
  if (extra) params.push(extra);
  return params.length ? `${BASE}${sep}${params.join('&')}` : BASE;
};

async function newCtx(browser) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DSF,
    ignoreHTTPSErrors: BASE.startsWith('https'),
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  await page.addInitScript(
    ([skin, planUsage, font]) => {
      try {
        localStorage.setItem('codeman:skin', skin);
        localStorage.setItem('codeman-font-size', String(font));
        const blob = { skin, showFileBrowser: false, showProjectInsights: false };
        if (planUsage) blob.showPlanUsageLimits = true;
        localStorage.setItem('codeman-app-settings', JSON.stringify(blob));
      } catch {
        /* ignore */
      }
    },
    [SKIN, PLAN_USAGE, FONT]
  );
  return { context, page };
}

async function bootstrap(page) {
  await page.waitForFunction(() => window.app && window.app.terminal, { timeout: 20000 });
  await sleep(1200);
}

async function listSessions(page) {
  return page.evaluate(() =>
    Array.from(window.app.sessions.values()).map((s) => ({ id: s.id, name: s.name, mode: s.mode }))
  );
}

async function shoot(page, name) {
  const out = join(OUT, name);
  await page.evaluate((f) => {
    try {
      if (window.app.setFontSize) window.app.setFontSize(f);
    } catch {}
    try {
      window.app.fitAddon && window.app.fitAddon.fit();
    } catch {}
    try {
      window.app.applyHeaderVisibilitySettings && window.app.applyHeaderVisibilitySettings();
    } catch {}
  }, FONT);
  await sleep(1500);
  await page.screenshot({ path: out, fullPage: false });
  console.log('  Saved: ' + out);
}

async function sceneDashboard(browser) {
  console.log('Scene: dashboard');
  const { context, page } = await newCtx(browser);
  await page.goto(url(), { waitUntil: 'domcontentloaded' });
  await bootstrap(page);
  const sessions = await listSessions(page);
  // Select a claude session so the active terminal shows rich content; all tabs render.
  const target = sessions.find((s) => s.mode === 'claude') || sessions[0];
  if (target) await page.evaluate((id) => window.app.selectSession(id), target.id);
  await sleep(4000);
  await shoot(page, 'multi-session-dashboard.png');
  await context.close();
}

async function sceneMonitor(browser) {
  console.log('Scene: monitor');
  const { context, page } = await newCtx(browser);
  await page.goto(url(), { waitUntil: 'domcontentloaded' });
  await bootstrap(page);
  const sessions = await listSessions(page);
  const target = sessions.find((s) => s.mode === 'claude') || sessions[0];
  if (target) await page.evaluate((id) => window.app.selectSession(id), target.id);
  await sleep(2500);
  // toggleMonitorPanel() opens the panel, clears the hidden state, loads REAL
  // mux sessions (/api/mux), starts stats, and renders the task panel.
  await page.evaluate(async () => {
    try {
      await window.app.toggleMonitorPanel();
    } catch {}
  });
  await sleep(3000);
  await shoot(page, 'multi-session-monitor.png');
  await context.close();
}

async function sceneSubagent(browser) {
  console.log('Scene: subagent');
  const { context, page } = await newCtx(browser);
  await page.goto(url(), { waitUntil: 'domcontentloaded' });
  await bootstrap(page);
  // Select the session whose subagents we want (subagentActiveTabOnly means
  // app.subagents only fills for the active tab). Prefer SUBAGENT_SID env.
  const sessions = await listSessions(page);
  const targetId = process.env.SUBAGENT_SID || (sessions.find((s) => s.mode === 'claude') || sessions[0])?.id;
  if (targetId) await page.evaluate((id) => window.app.selectSession(id), targetId);
  // Wait (up to ~25s) for live subagents to arrive via SSE into app.subagents.
  let agents = [];
  for (let i = 0; i < 25; i++) {
    agents = await page.evaluate(() =>
      Array.from(window.app.subagents?.entries?.() || []).map(([id, a]) => ({ id, name: a.name ?? a.agentType ?? '' }))
    );
    if (agents.length >= 1) break;
    await sleep(1000);
  }
  console.log('  live in-browser subagents:', JSON.stringify(agents));
  if (agents.length === 0) {
    console.log('  NO live subagents — skipping (stage a longer subagent task and run this while it runs).');
    await context.close();
    return;
  }
  await page.evaluate(
    (ids) => {
      ids.slice(0, 2).forEach((id) => {
        try {
          window.app.openSubagentWindow(id);
        } catch {}
      });
    },
    agents.map((a) => a.id)
  );
  await sleep(2000);
  await page.evaluate(() => {
    const wins = Array.from(window.app.subagentWindows.values());
    const place = [
      { left: 360, top: 60, w: 430, h: 330 },
      { left: 810, top: 60, w: 430, h: 330 },
    ];
    wins.slice(0, 2).forEach((win, i) => {
      const el = win.element;
      const p = place[i];
      el.style.left = p.left + 'px';
      el.style.top = p.top + 'px';
      el.style.width = p.w + 'px';
      el.style.height = p.h + 'px';
    });
  });
  await sleep(1500);
  await shoot(page, 'subagent-spawn.png');
  await context.close();
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  console.log(`BASE=${BASE} SKIN=${SKIN} DSF=${DSF} VIEWPORT=${VIEWPORT.width}x${VIEWPORT.height} SCENE=${SCENE}`);
  if (SCENE === 'dashboard' || SCENE === 'all') await sceneDashboard(browser);
  if (SCENE === 'monitor' || SCENE === 'all') await sceneMonitor(browser);
  if (SCENE === 'subagent' || SCENE === 'all') await sceneSubagent(browser);
  await browser.close();
}

main().catch((e) => {
  console.error('FATAL', e.message);
  process.exit(1);
});
