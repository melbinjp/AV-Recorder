// End-to-end tests: real recordings in Chromium with fake devices.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { devices } from 'playwright';
import { startServer, launch, openApp, waitState, state, reviewInfo, sleep } from './helpers.mjs';

let server;
let browser;

before(async () => {
  server = await startServer();
  browser = await launch();
});

after(async () => {
  await browser?.close();
  await server?.close();
});

// With permission already granted the app starts the camera/mic preview by
// itself; screen modes always need the button (the browser's share picker).
async function startPreview(page) {
  await page.waitForFunction(() => window.AVR.app.state !== 'starting');
  if ((await state(page)) === 'idle') {
    await page.waitForTimeout(300);
    if ((await state(page)) === 'idle') await page.click('#previewBtn');
  }
  await waitState(page, 'preview');
}

async function record(page, ms) {
  await page.click('#recordBtn');
  await waitState(page, 'recording');
  await page.waitForFunction(() => window.AVR.app.session && window.AVR.app.session.seq > 0, null, { timeout: 10000 });
  await sleep(ms);
}

async function stop(page) {
  await page.click('#recordBtn');
  await waitState(page, 'review', 20000);
}

test('loads cleanly and fits every screen width without sideways scrolling', async () => {
  const { page, errors, context } = await openApp(browser, server.url);
  for (const width of [320, 375, 414, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    await sleep(100);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `horizontal overflow of ${overflow}px at ${width}px`);
  }
  // Permission is pre-granted here, so the camera preview starts by itself.
  await waitState(page, 'preview');
  assert.deepEqual(errors, []);
  await context.close();
});

test('records the camera with pause, and the file knows its duration', async () => {
  const { page, errors, context } = await openApp(browser, server.url);
  await startPreview(page);
  const t0 = Date.now();
  await record(page, 2000);
  const p0 = Date.now();
  await page.click('#pauseBtn');
  await waitState(page, 'paused');
  await sleep(1500);
  await page.click('#pauseBtn');
  await waitState(page, 'recording');
  const pausedFor = Date.now() - p0;
  await sleep(1500);
  await stop(page);
  const expected = Date.now() - t0 - pausedFor;

  const info = await reviewInfo(page);
  assert.equal(info.kind, 'video');
  assert.ok(info.size > 20000, `file too small: ${info.size}`);
  assert.ok(info.saved, 'recording should be saved to the library');
  // The pause must not count towards the length.
  assert.ok(Math.abs(info.durationMs - expected) < 700, `duration ${info.durationMs}ms, expected about ${expected}ms`);
  if (info.type.includes('webm')) {
    assert.ok(Math.abs(info.headerDurationMs - info.durationMs) < 5, 'WebM header should carry the duration: ' + JSON.stringify(info));
    assert.ok(Number.isFinite(info.elementDuration), `player duration should be finite, got ${info.elementDuration}`);
  }
  assert.ok(info.width > 0 && info.height > 0);

  // It is in the library, with a thumbnail.
  await page.waitForSelector('#libraryList .rec-card');
  assert.equal(await page.locator('#libraryList .rec-card').count(), 1);
  await page.waitForSelector('#libraryList .rec-card img', { timeout: 5000 });

  // Download gives a correctly named file with the right bytes.
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#downloadBtn')]);
  assert.match(download.suggestedFilename(), /^Camera \d{4}-\d\d-\d\d \d\d-\d\d-\d\d\.(webm|mp4)$/);
  const bytes = await readFile(await download.path());
  assert.equal(bytes.length, info.size);
  if (info.ext === 'webm') assert.deepEqual([...bytes.subarray(0, 4)], [0x1a, 0x45, 0xdf, 0xa3]);

  assert.deepEqual(errors, []);
  await context.close();
});

test('records audio only and exports WAV', async () => {
  const { page, errors, context } = await openApp(browser, server.url, { settings: { mode: 'audio' } });
  await startPreview(page);
  assert.equal(await page.isVisible('#audioViz'), true);
  await record(page, 2500);
  await stop(page);
  const info = await reviewInfo(page);
  assert.equal(info.kind, 'audio');
  assert.match(info.type, /^audio\//);
  assert.ok(info.size > 2000);

  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#wavBtn')]);
  assert.match(download.suggestedFilename(), /\.wav$/);
  const wav = await readFile(await download.path());
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString(), 'WAVE');
  const rate = wav.readUInt32LE(24);
  const channels = wav.readUInt16LE(22);
  const seconds = (wav.length - 44) / (rate * channels * 2);
  assert.ok(seconds > 1.5 && seconds < 4, `WAV length ${seconds}s`);
  assert.deepEqual(errors, []);
  await context.close();
});

test('records the screen with computer sound and microphone mixed into one track', async () => {
  const { page, errors, context } = await openApp(browser, server.url, { settings: { mode: 'screen' } });
  await startPreview(page);
  await record(page, 1500);
  const tracks = await page.evaluate(() => {
    const s = window.AVR.app.session.stream;
    return { video: s.getVideoTracks().length, audio: s.getAudioTracks().length, mixed: !!window.AVR.app.mixer };
  });
  assert.deepEqual(tracks, { video: 1, audio: 1, mixed: true });
  await stop(page);
  const info = await reviewInfo(page);
  assert.ok(info.width > 0);
  assert.ok(info.size > 5000);
  assert.deepEqual(errors, []);
  await context.close();
});

test('screen + camera draws a draggable bubble into the recording', async () => {
  const { page, errors, context } = await openApp(browser, server.url, { settings: { mode: 'screencam' } });
  await startPreview(page);
  const canvas = await page.evaluate(() => {
    const c = window.AVR.app.compositor;
    return c && { w: c.canvas.width, h: c.canvas.height, layout: c.layout };
  });
  assert.ok(canvas, 'compositor should be running');
  assert.equal(canvas.layout, 'bubble');

  // Drag the bubble from bottom-right towards the top-left.
  const box = await page.locator('#canvasHost canvas').boundingBox();
  const rect = await page.evaluate(() => window.AVR.app.compositor.bubbleRect());
  const scale = box.width / canvas.w;
  const startX = box.x + (rect.x + rect.w / 2) * scale;
  const startY = box.y + (rect.y + rect.h / 2) * scale;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(box.x + 40, box.y + 40, { steps: 8 });
  await page.mouse.up();
  const pos = await page.evaluate(() => ({ x: window.AVR.settings.bubble.x, y: window.AVR.settings.bubble.y }));
  assert.ok(pos.x < 0.2 && pos.y < 0.2, `bubble should have moved, got ${JSON.stringify(pos)}`);

  await record(page, 1500);
  await page.keyboard.press('c'); // hide the camera mid-recording
  assert.equal(await page.evaluate(() => window.AVR.app.compositor.showCamera), false);
  await sleep(500);
  await stop(page);
  const info = await reviewInfo(page);
  assert.equal(info.width, canvas.w);
  assert.equal(info.height, canvas.h);
  assert.deepEqual(errors, []);
  await context.close();
});

test('crops the camera to 9:16 for Shorts', async () => {
  const { page, errors, context } = await openApp(browser, server.url, { settings: { aspect: '9:16' } });
  await startPreview(page);
  await record(page, 1200);
  await stop(page);
  const info = await reviewInfo(page);
  assert.ok(Math.abs(info.width / info.height - 9 / 16) < 0.02, `got ${info.width}x${info.height}`);
  assert.deepEqual(errors, []);
  await context.close();
});

test('recovers a recording after the tab is closed mid-recording', async () => {
  const { page, context } = await openApp(browser, server.url);
  await startPreview(page);
  await record(page, 3500);
  // Simulate a crash: close without stopping (no beforeunload, no cleanup).
  await page.close({ runBeforeUnload: false });

  const again = await context.newPage();
  await again.goto(server.url);
  await again.waitForFunction(() => window.AVR && window.AVR.app);
  await again.waitForSelector('#libraryList .rec-card', { timeout: 10000 });
  const card = again.locator('#libraryList .rec-card').first();
  assert.match(await card.innerText(), /Recovered/);
  const rec = await again.evaluate(async () => (await window.AVR.store.listRecordings())[0]);
  assert.equal(rec.status, 'complete');
  assert.ok(rec.durationMs >= 2000, `recovered ${rec.durationMs}ms`);

  await card.locator('[data-action="play"]').click();
  await waitState(again, 'review');
  const info = await reviewInfo(again);
  assert.ok(info.size > 10000);
  if (info.type.includes('webm')) assert.ok(Number.isFinite(info.elementDuration));
  await context.close();
});

test('countdown can be cancelled, and keyboard shortcuts drive recording', async () => {
  const { page, errors, context } = await openApp(browser, server.url, { settings: { countdown: 3, countdownBeep: false } });
  await startPreview(page);
  await page.keyboard.press('r');
  await waitState(page, 'countdown');
  assert.equal(await page.isVisible('#countdownOverlay'), true);
  await page.keyboard.press('Escape');
  await waitState(page, 'preview');

  await page.evaluate(() => { window.AVR.settings.countdown = 0; });
  await page.keyboard.press('r');
  await waitState(page, 'recording');
  await page.waitForFunction(() => window.AVR.app.session.state === 'recording');
  await page.keyboard.press('m');
  assert.equal(await page.evaluate(() => window.AVR.app.muted), true);
  assert.equal(await page.evaluate(() => window.AVR.app.sources.track('mic').enabled), false);
  await page.keyboard.press('p');
  await waitState(page, 'paused');
  await page.keyboard.press('p');
  await waitState(page, 'recording');
  await sleep(1200);
  await page.keyboard.press('r');
  await waitState(page, 'review', 20000);
  assert.deepEqual(errors, []);
  await context.close();
});

test('teleprompter scrolls while recording and stops when paused', async () => {
  const text = Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of the script.`).join('\n');
  const { page, errors, context } = await openApp(browser, server.url, {
    settings: { prompter: { visible: true, text, speed: 10, fontSize: 32, autoStart: true } },
  });
  await startPreview(page);
  assert.equal(await page.isVisible('#prompter'), true);
  await record(page, 1500);
  const moved = await page.evaluate(() => window.AVR.app.prompter.offset);
  assert.ok(moved > 20, `prompter offset ${moved}`);
  await page.click('#pauseBtn');
  await waitState(page, 'paused');
  const a = await page.evaluate(() => window.AVR.app.prompter.offset);
  await sleep(500);
  const b = await page.evaluate(() => window.AVR.app.prompter.offset);
  assert.equal(a, b);
  await page.click('#recordBtn');
  await waitState(page, 'review', 20000);
  // Never over the playback.
  assert.equal(await page.isVisible('#prompter'), false);
  assert.deepEqual(errors, []);
  await context.close();
});

test('still records when the browser refuses on-device storage', async () => {
  const { page, context } = await openApp(browser, server.url, {
    initScript: () => { Object.defineProperty(window, 'indexedDB', { value: undefined }); },
  });
  await page.waitForSelector('#libraryEmpty:not([hidden])');
  assert.match(await page.innerText('#libraryEmpty'), /download each one/i);
  await startPreview(page);
  await record(page, 1500);
  await stop(page);
  const info = await reviewInfo(page);
  assert.equal(info.saved, false);
  assert.ok(info.size > 5000);
  assert.match(await page.innerText('#reviewInfo'), /download it now/);
  await context.close();
});

test('survives corrupt saved settings', async () => {
  const { page, errors, context } = await openApp(browser, server.url, {
    initScript: () => { localStorage.setItem('avr.settings.v1', '{"mode":"nonsense","fps":"x","bubble":7,'); },
  });
  assert.equal(await page.evaluate(() => window.AVR.settings.mode), 'camera');
  assert.deepEqual(errors, []);
  await context.close();
});

test('on a phone, screen modes explain why they are unavailable', async () => {
  const { page, errors, context } = await openApp(browser, server.url, {
    contextOptions: { ...devices['iPhone 13'] },
    settings: { mode: 'screen' },
  });
  // A saved screen mode falls back to the camera on a phone, and screen modes
  // are not offered at all.
  assert.equal(await page.evaluate(() => window.AVR.settings.mode), 'camera');
  assert.equal(await page.isVisible('.mode-tab[data-mode="screen"]'), false);
  assert.equal(await page.isVisible('.mode-tab[data-mode="screencam"]'), false);
  assert.equal(await page.isVisible('.mode-tab[data-mode="audio"]'), true);
  // If something still asks for it (a shortcut link), it explains itself.
  await page.evaluate(() => window.AVR.app.selectMode('screen'));
  await page.waitForSelector('.toast');
  assert.match(await page.innerText('.toast'), /built-in screen recorder/);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0);
  await startPreview(page);
  // Flip appears only when the phone has more than one camera (the fake has one).
  assert.equal(await page.evaluate(() => window.AVR.platform.isMobile), true);
  assert.equal(await page.isVisible('#flipBtn'), false);
  assert.equal(await page.isVisible('#popoutBtn'), false);
  assert.deepEqual(errors, []);
  await context.close();
});

test('picks a format the browser can record, and names files to match', async () => {
  const { page, context } = await openApp(browser, server.url);
  const r = await page.evaluate(() => ({
    video: window.AVR.formats.pick('video', 'auto'),
    audio: window.AVR.formats.pick('audio', 'auto'),
    ext: [
      window.AVR.formats.extFor('video/mp4;codecs=avc1', 'video'),
      window.AVR.formats.extFor('audio/mp4', 'audio'),
      window.AVR.formats.extFor('video/webm;codecs=vp9', 'video'),
      window.AVR.formats.extFor('audio/ogg;codecs=opus', 'audio'),
    ],
    bitrate1080: window.AVR.formats.videoBitrate(1920, 1080, 30, 'high'),
    bitrate1080p60: window.AVR.formats.videoBitrate(1920, 1080, 60, 'high'),
  }));
  assert.ok(r.video && MediaRecorderSupported(r.video.mime));
  assert.ok(r.audio);
  assert.deepEqual(r.ext, ['mp4', 'm4a', 'webm', 'ogg']);
  assert.equal(r.bitrate1080, 8e6);
  assert.equal(r.bitrate1080p60, 12e6);
  await context.close();
});

function MediaRecorderSupported(mime) {
  return typeof mime === 'string' && mime.includes('/');
}
