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

async function recording(page) {
  await waitState(page, 'preview');
  await page.click('#recordBtn');
  await waitState(page, 'recording');
  await page.waitForFunction(() => window.AVR.app.session && window.AVR.app.session.state === 'recording');
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
