// Failure paths: what happens when the encoder, the disk or memory give out.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, launch, openApp, waitState, reviewInfo, sleep } from './helpers.mjs';

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

// Starts recording and waits until the first chunk exists, so a stop is
// never a zero-length recording by accident.
async function recording(page) {
  await waitState(page, 'preview');
  await page.click('#recordBtn');
  await waitState(page, 'recording');
  await page.waitForFunction(() => window.AVR.app.session && window.AVR.app.session.seq > 0);
}

test('a recorder failure saves part 1 and carries on recording as part 2', async () => {
  const { page, errors, context } = await openApp(browser, server.url);
  await recording(page);
  await sleep(3500);
  const firstId = await page.evaluate(() => window.AVR.app.session.id);

  // What Chrome does when its encoder fails mid-recording.
  await page.evaluate(() => window.AVR.app.session.recorder.dispatchEvent(new Event('error')));
  await page.waitForFunction((id) => {
    const s = window.AVR.app.session;
    return window.AVR.app.state === 'recording' && s && s.id !== id && s.state === 'recording';
  }, firstId, { timeout: 15000 });
  assert.match(await page.innerText('#recBadgeLabel'), /part 2/);
  await sleep(2000);
  await page.click('#recordBtn');
  await waitState(page, 'review', 20000);

  const recs = await page.evaluate(async () => (await window.AVR.store.listRecordings()).map((r) => ({ name: r.name, status: r.status, ms: r.durationMs })));
  assert.equal(recs.length, 2);
  assert.ok(recs.every((r) => r.status === 'complete'));
  assert.ok(recs.some((r) => / \(part 1\)$/.test(r.name)), JSON.stringify(recs));
  assert.ok(recs.some((r) => / \(part 2\)$/.test(r.name)), JSON.stringify(recs));
  assert.ok(recs.every((r) => r.ms > 1000), JSON.stringify(recs));
  const log = await page.evaluate(() => window.AVR.logEntries().map((e) => e.event));
  assert.ok(log.includes('recorder-error'));
  assert.deepEqual(errors, []);
  await context.close();
});

test('when storage fails and memory runs short, it stops and saves by itself', async () => {
  const { page, context } = await openApp(browser, server.url, {
    initScript: () => { Object.defineProperty(window, 'indexedDB', { value: undefined }); },
  });
  await page.evaluate(() => { window.AVR.RecordingSession.memoryBudget = 150 * 1024; });
  await recording(page);
  await waitState(page, 'review', 20000);
  const info = await reviewInfo(page);
  assert.ok(info.size > 150 * 1024, `saved ${info.size} bytes`);
  assert.equal(info.saved, false);
  assert.match(await page.innerText('#toastContainer'), /Out of space/);
  await context.close();
});

test('saving never hangs, and loses nothing, when browser storage stalls', async () => {
  const { page, context } = await openApp(browser, server.url);
  await page.evaluate(() => { window.AVR.RecordingSession.storageWait = 1500; });
  await recording(page);
  await page.waitForFunction(() => window.AVR.app.session.seq >= 2);
  // From here on, every write to storage hangs and never completes.
  await page.evaluate(() => { window.AVR.store.appendChunk = () => new Promise(() => {}); });
  const t0 = Date.now();
  await sleep(2500);
  await page.click('#recordBtn');
  await waitState(page, 'review', 15000);
  const info = await reviewInfo(page);
  const recordedFor = Date.now() - t0;
  // The unconfirmed chunks came from memory: the file covers the whole take.
  assert.ok(info.durationMs >= recordedFor - 800, `file is ${info.durationMs}ms of about ${recordedFor}ms+`);
  if (info.type.includes('webm')) assert.ok(Number.isFinite(info.elementDuration));
  const played = await page.evaluate(async () => {
    const v = document.getElementById('playbackVideo');
    v.muted = true;
    v.currentTime = Math.max(0, v.duration - 0.5);
    await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
    return v.currentTime;
  });
  assert.ok(played > info.durationMs / 1000 - 1.5, `could not seek to the end (${played}s)`);
  const log = await page.evaluate(() => window.AVR.logEntries().map((e) => e.event));
  assert.ok(log.includes('storage-slow'), JSON.stringify(log));
  await context.close();
});

test('warns before and during a recording when the device is nearly full', async () => {
  const { page, context } = await openApp(browser, server.url, {
    initScript: () => {
      // A device with 40 MB left for this site.
      const fake = () => Promise.resolve({ usage: 1024 * 1024, quota: 41 * 1024 * 1024 });
      Object.defineProperty(navigator.storage, 'estimate', { value: fake });
    },
  });
  await recording(page);
  await page.waitForSelector('.toast.warning');
  assert.match(await page.innerText('#toastContainer'), /room for only about \d+ more minute/);
  await page.waitForFunction(() => /min left/.test(document.getElementById('recSize').textContent));
  await page.click('#recordBtn');
  await waitState(page, 'review', 20000);
  await context.close();
});

test('stopping a split second after starting keeps the preview and says why', async () => {
  const { page, errors, context } = await openApp(browser, server.url);
  await waitState(page, 'preview');
  // Record and stop in the same instant: the encoder cannot have produced
  // anything yet.
  await page.evaluate(() => { window.AVR.app.onRecordPressed(); window.AVR.app.onRecordPressed(); });
  await waitState(page, 'preview');
  await page.waitForSelector('.toast');
  assert.match(await page.innerText('#toastContainer'), /too short/);
  assert.equal(await page.evaluate(() => window.AVR.app.sources.isLive('cam')), true, 'the camera stays on');
  await sleep(500);
  const recs = await page.evaluate(async () => (await window.AVR.store.listRecordings()).length);
  assert.equal(recs, 0, 'no empty recording is left behind');
  // And it records normally straight after.
  await page.click('#recordBtn');
  await waitState(page, 'recording');
  await page.waitForFunction(() => window.AVR.app.session.seq > 0);
  await page.click('#recordBtn');
  await waitState(page, 'review', 20000);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a slow first frame (camera warm-up) still gives the file its duration', async () => {
  const { page, errors, context } = await openApp(browser, server.url);
  // Drive a real RecordingSession with a source that sends no frames for the
  // first 1.5 s, as a phone camera warming up does. Chrome then delivers the
  // file header split across chunks, starting with a single byte.
  const r = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext('2d');
    const stream = canvas.captureStream(30);
    const session = new window.AVR.RecordingSession({
      stream, kind: 'video', mode: 'camera', name: 'Warm-up test',
      format: window.AVR.formats.pick('video', 'video/webm;codecs=vp9,opus'), videoBitsPerSecond: 2e6,
    });
    await session.start();
    await new Promise((res) => setTimeout(res, 1500));
    const t0 = performance.now();
    await new Promise((res) => {
      (function draw() {
        ctx.fillStyle = `hsl(${(performance.now() / 8) % 360},80%,50%)`;
        ctx.fillRect(0, 0, 640, 360);
        if (performance.now() - t0 < 2000) requestAnimationFrame(draw); else res();
      })();
    });
    const result = await session.stop();
    const stored = await window.AVR.RecordingSession.loadBlob(await window.AVR.store.getRecording(result.id));
    const chunks = await window.AVR.store.getChunks(result.id);
    return {
      firstChunkBytes: session.headBlobs[0] && session.headBlobs[0].size,
      fileDuration: await window.AVR.webm.readDuration(result.blob),
      storedDuration: await window.AVR.webm.readDuration(stored),
      ms: result.durationMs,
      sameSize: stored.size === result.blob.size,
      chunks: chunks.length,
    };
  });
  assert.ok(r.fileDuration > 0, `the finished file has no duration: ${JSON.stringify(r)}`);
  assert.equal(r.fileDuration, r.ms);
  assert.equal(r.storedDuration, r.ms, 'the saved copy must carry it too');
  assert.ok(r.sameSize);
  assert.deepEqual(errors, []);
  await context.close();
});

test('crash recovery also finds a header split across chunks', async () => {
  const { page, context } = await openApp(browser, server.url);
  const r = await page.evaluate(async () => {
    // Record a real WebM, then store it the way a crash would leave it:
    // split with a lone first byte, marked as still recording.
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 240;
    const ctx = canvas.getContext('2d');
    const rec = new MediaRecorder(canvas.captureStream(30), { mimeType: 'video/webm;codecs=vp8' });
    const parts = [];
    rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
    rec.start();
    const t0 = performance.now();
    await new Promise((res) => {
      (function draw() {
        ctx.fillStyle = `hsl(${(performance.now() / 8) % 360},80%,50%)`;
        ctx.fillRect(0, 0, 320, 240);
        if (performance.now() - t0 < 1500) requestAnimationFrame(draw); else res();
      })();
    });
    rec.stop();
    await new Promise((res) => (rec.onstop = res));
    const file = new Blob(parts, { type: 'video/webm' });
    const id = 'crashed-' + Date.now();
    await window.AVR.store.putRecording({
      id, name: 'Crashed', mode: 'camera', kind: 'video', mimeType: 'video/webm', ext: 'webm',
      createdAt: Date.now() - 120000, updatedAt: Date.now() - 120000, durationMs: 1500, size: file.size,
      chunkCount: 2, status: 'recording', thumb: null,
    });
    await window.AVR.store.putChunk(id, 0, file.slice(0, 1, 'video/webm'));
    await window.AVR.store.putChunk(id, 1, file.slice(1, file.size, 'video/webm'));
    const recovered = await window.AVR.RecordingSession.recoverAll();
    const saved = await window.AVR.store.getRecording(id);
    const blob = await window.AVR.RecordingSession.loadBlob(saved);
    return { recovered: recovered.length, status: saved.status, duration: await window.AVR.webm.readDuration(blob), size: blob.size, original: file.size };
  });
  assert.equal(r.recovered, 1);
  assert.equal(r.status, 'complete');
  assert.equal(r.duration, 1500);
  // Either an existing Duration was overwritten in place, or one was inserted.
  assert.ok(r.size === r.original || r.size === r.original + 11, `size ${r.size} from ${r.original}`);
  await context.close();
});

test('diagnostics report the version, capabilities and recent events', async () => {
  const { page, context } = await openApp(browser, server.url, {
    contextOptions: { permissions: ['clipboard-read', 'clipboard-write'] },
  });
  await recording(page);
  await sleep(1200);
  await page.click('#recordBtn');
  await waitState(page, 'review', 20000);
  await page.click('#helpBtn');
  await page.click('#diagnostics summary');
  await page.waitForFunction(() => /Recent events/.test(document.getElementById('diagText').textContent));
  const text = await page.innerText('#diagText');
  const version = await page.evaluate(() => window.AVR.VERSION);
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.ok(text.startsWith('AV Recorder ' + version));
  assert.match(text, /Video formats: .+/);
  assert.match(text, /INFO record-start/);
  assert.match(text, /INFO record-saved/);
  assert.equal(await page.innerText('#appVersion'), version);
  await page.click('#copyDiagBtn');
  await page.waitForFunction(() => /Diagnostics copied/.test(document.getElementById('toastContainer').textContent));
  await context.close();
});
