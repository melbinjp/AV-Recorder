// After one visit the app must load and record with no connection at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';
import { launchRaw } from './cdp.mjs';

test('loads and records offline once it has been visited', async () => {
  const server = await startServer();
  const chrome = await launchRaw({ url: server.url });
  try {
    let page = await chrome.attach();
    await page.waitFor(`(async () => !!navigator.serviceWorker.controller &&
      (await (await caches.open((await caches.keys()).find(k => k.startsWith('avr-')))).keys()).length > 10)()`);
    await page.close();

    // The server is gone: every request now fails unless the app is cached.
    await server.close();
    page = await chrome.attach();
    await page.send('Page.reload');
    await new Promise((r) => setTimeout(r, 1500));
    page.close();
    page = await chrome.attach();
    await page.waitFor('!!(window.AVR && window.AVR.app)');
    assert.equal(await page.evaluate('document.title'), 'Audio Video Recorder | WeCanUseAI');

    // And it can still record.
    await page.evaluate(`(() => { AVR.settings.countdown = 0; })()`);
    await page.waitFor(`AVR.app.state === 'idle' || AVR.app.state === 'preview'`);
    await page.evaluate(`(() => { if (AVR.app.state === 'idle') document.getElementById('previewBtn').click(); })()`);
    await page.waitFor(`AVR.app.state === 'preview'`);
    await page.evaluate(`document.getElementById('recordBtn').click()`);
    await page.waitFor(`AVR.app.session && AVR.app.session.seq > 1`);
    await page.evaluate(`document.getElementById('recordBtn').click()`);
    await page.waitFor(`AVR.app.state === 'review'`, 20000);
    assert.ok((await page.evaluate('AVR.app.review.item.blob.size')) > 5000);
    page.close();
  } finally {
    await chrome.close();
    await server.close().catch(() => {});
  }
});
