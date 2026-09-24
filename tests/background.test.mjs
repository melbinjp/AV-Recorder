// Screen + camera recordings keep their frame rate while the recorder's tab is
// in the background, which is the normal situation when recording another app.
// Needs a real (virtual) display for tab visibility: run under xvfb-run on Linux.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';
import { launchRaw } from './cdp.mjs';

const canRun = process.platform !== 'linux' || !!process.env.DISPLAY;

test('keeps recording at full frame rate while the tab is hidden', { skip: !canRun && 'no display (run with xvfb-run)' }, async () => {
  const server = await startServer();
  const chrome = await launchRaw({ url: server.url + '?mode=screencam', headless: false });
  try {
    const page = await chrome.attach();
    await page.waitFor('!!(window.AVR && window.AVR.app)');
    await page.evaluate(`(() => { AVR.settings.countdown = 0; AVR.settings.fps = 30; })()`);
    await page.evaluate(`document.getElementById('previewBtn').click()`);
    await page.waitFor(`AVR.app.state === 'preview' && !!AVR.app.compositor`);
    await page.evaluate(`document.getElementById('recordBtn').click()`);
    await page.waitFor(`AVR.app.session && AVR.app.session.state === 'recording'`);

    // Count the frames the recorder receives, split by tab visibility.
    await page.evaluate(`(() => {
      window.__frames = { visible: 0, hidden: 0 };
      const track = AVR.app.session.stream.getVideoTracks()[0].clone();
      const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
      (async () => { for (;;) { const { value, done } = await reader.read(); if (done) break; __frames[document.visibilityState]++; value.close(); } })();
    })()`);

    await new Promise((r) => setTimeout(r, 1000));
    const tab = await chrome.openTab('about:blank');
    await page.waitFor(`document.visibilityState === 'hidden'`);
    const hiddenStart = await page.evaluate('__frames.hidden');
    await new Promise((r) => setTimeout(r, 4000));
    const hiddenFrames = (await page.evaluate('__frames.hidden')) - hiddenStart;
    await chrome.activate(page.targetId);
    await page.waitFor(`document.visibilityState === 'visible'`);
    assert.ok(tab.id);

    // 4s at 30fps is 120 frames; allow for a slow CI machine. A requestAnimationFrame
    // loop would deliver 0, and throttled timers about 4.
    assert.ok(hiddenFrames >= 60, `only ${hiddenFrames} frames while hidden`);

    await page.evaluate(`document.getElementById('recordBtn').click()`);
    await page.waitFor(`AVR.app.state === 'review'`, 20000);
    page.close();
  } finally {
    await chrome.close();
    await server.close();
  }
});
