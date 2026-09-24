// Shared test plumbing: a static file server for the app and a Chromium set up
// with fake camera, microphone and screen, so recordings can be made headless.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export async function startServer() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let file = path.join(ROOT, decodeURIComponent(url.pathname));
      if (!file.startsWith(ROOT)) throw new Error('outside root');
      if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  // localhost (not 127.0.0.1) so the page is a secure context with a service worker.
  return { url: `http://localhost:${port}/`, close: () => new Promise((r) => server.close(r)) };
}

export const MEDIA_ARGS = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--auto-select-desktop-capture-source=Entire screen',
  '--autoplay-policy=no-user-gesture-required',
];

export function launch(options = {}) {
  return chromium.launch({ args: MEDIA_ARGS, ...options });
}

// Opens the app in a fresh context. `settings` are merged into the saved
// preferences before the page loads (countdown off by default, for speed).
export async function openApp(browser, baseUrl, { settings = {}, contextOptions = {}, initScript } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, ...contextOptions });
  await context.grantPermissions(['camera', 'microphone'], { origin: baseUrl.replace(/\/$/, '') });
  const saved = { countdown: 0, ...settings };
  await context.addInitScript((s) => {
    try {
      if (!sessionStorage.getItem('__seeded')) {
        localStorage.setItem('avr.settings.v1', JSON.stringify(s));
        sessionStorage.setItem('__seeded', '1');
      }
    } catch (e) { /* ignore */ }
  }, saved);
  if (initScript) await context.addInitScript(initScript);
  const page = await context.newPage();
  const errors = trackErrors(page);
  await page.goto(baseUrl);
  await page.waitForFunction(() => window.AVR && window.AVR.app);
  return { context, page, errors };
}

export function trackErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
  });
  return errors;
}

// Waits for an app state. On timeout the error says where the app actually
// was, including its recent diagnostics events, so a failure explains itself.
export async function waitState(page, state, timeout = 15000) {
  try {
    await page.waitForFunction((s) => window.AVR.app.state === s, state, { timeout });
  } catch (err) {
    const where = await page.evaluate(() => {
      const app = window.AVR && window.AVR.app;
      const rec = app && app.session && app.session.recorder;
      return {
        state: app && app.state,
        session: app && app.session && { state: app.session.state, seq: app.session.seq, bytes: app.session.bytes },
        recorder: rec && rec.state,
        toasts: Array.from(document.querySelectorAll('.toast-msg')).map((t) => t.textContent),
        log: window.AVR.logEntries ? window.AVR.logEntries().slice(-12) : [],
      };
    }).catch((e) => ({ unavailable: e.message }));
    throw new Error(`waited ${timeout}ms for state "${state}": ${JSON.stringify(where)}`);
  }
}

export function state(page) {
  return page.evaluate(() => window.AVR.app.state);
}

// Metadata of the recording shown in the review panel, as the browser sees it.
export async function reviewInfo(page) {
  await page.waitForFunction(() => {
    const v = document.getElementById('playbackVideo');
    return v.readyState >= 1;
  }, null, { timeout: 15000 });
  return page.evaluate(async () => {
    const r = window.AVR.app.review.item;
    const v = document.getElementById('playbackVideo');
    return {
      name: r.name,
      ext: r.ext,
      kind: r.kind,
      size: r.blob.size,
      type: r.blob.type,
      saved: r.saved,
      durationMs: r.durationMs,
      headerDurationMs: /webm/.test(r.blob.type) ? await window.AVR.webm.readDuration(r.blob) : null,
      elementDuration: v.duration,
      width: v.videoWidth,
      height: v.videoHeight,
    };
  });
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
