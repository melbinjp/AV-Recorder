// Drives Chromium directly over the DevTools protocol, without Playwright
// attached. Two things need this: Playwright routes page traffic around service
// workers (so it cannot test offline mode), and it disables background-tab
// throttling (so it cannot test recording while the tab is hidden).
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { MEDIA_ARGS } from './helpers.mjs';

export async function launchRaw({ url, headless = true, args = [] }) {
  const userDir = await mkdtemp(path.join(tmpdir(), 'avr-chrome-'));
  const port = 9300 + Math.floor(Math.random() * 500);
  const proc = spawn(chromium.executablePath(), [
    ...(headless ? ['--headless=new'] : []),
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--window-size=1280,860',
    ...MEDIA_ARGS,
    ...args,
    url,
  ], { stdio: 'ignore' });

  const base = `http://127.0.0.1:${port}`;
  let targets = [];
  for (let i = 0; i < 100; i++) {
    try {
      targets = await (await fetch(`${base}/json`)).json();
      if (targets.some((t) => t.type === 'page' && t.url.startsWith(url.split('?')[0]))) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }

  async function attach(match = (t) => t.type === 'page' && t.url.startsWith(url.split('?')[0])) {
    const list = await (await fetch(`${base}/json`)).json();
    const target = list.find(match);
    if (!target) throw new Error('page target not found');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let id = 0;
    const pending = new Map();
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
    };
    const send = (method, params = {}) => new Promise((resolve) => {
      const i = ++id;
      pending.set(i, resolve);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
      return r.result.result.value;
    };
    const waitFor = async (expression, timeout = 15000) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        try { if (await evaluate(expression)) return; } catch { /* page navigating */ }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('timed out waiting for: ' + expression);
    };
    return { send, evaluate, waitFor, close: () => ws.close(), targetId: target.id };
  }

  return {
    attach,
    async openTab(tabUrl) {
      const t = await (await fetch(`${base}/json/new?${tabUrl}`, { method: 'PUT' })).json();
      await fetch(`${base}/json/activate/${t.id}`);
      return t;
    },
    async activate(targetId) {
      await fetch(`${base}/json/activate/${targetId}`);
    },
    async close() {
      proc.kill();
      await new Promise((r) => setTimeout(r, 300));
      await rm(userDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
