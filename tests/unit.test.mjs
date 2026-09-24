// Unit tests for the pure parts: the WebM header patcher, formats, WAV
// encoding and formatting helpers. They run inside one page, so they test the
// exact code the browser runs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, launch } from './helpers.mjs';

let server;
let browser;
let page;

before(async () => {
  server = await startServer();
  browser = await launch();
  page = await browser.newPage();
  await page.goto(server.url);
  await page.waitForFunction(() => window.AVR && window.AVR.webm);
  // Helpers for building EBML byte sequences inside the page.
  await page.evaluate(() => {
    const vint = (n, len) => {
      len = len || (n < 127 ? 1 : n < 16383 ? 2 : n < 2097151 ? 3 : 4);
      const out = [];
      // Division, not >>: JavaScript shifts wrap at 32 bits.
      for (let i = len - 1; i >= 0; i--) out[i] = Math.floor(n / 2 ** (8 * (len - 1 - i))) & 0xff;
      out[0] |= 0x80 >> (len - 1);
      return out;
    };
    const id = (n) => {
      const out = [];
      while (n > 0) { out.unshift(n & 0xff); n = Math.floor(n / 256); }
      return out;
    };
    const el = (elId, data, sizeLen) => [...id(elId), ...vint(data.length, sizeLen), ...data];
    const uint = (n, len) => Array.from({ length: len }, (_, i) => (n >> (8 * (len - 1 - i))) & 0xff);
    const float64 = (v) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, false); return [...b]; };
    const float32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, false); return [...b]; };
    const UNKNOWN = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

    // A minimal WebM: EBML header, Segment (unknown size) → [SeekHead?] Info → Tracks → Cluster
    window.buildWebm = ({ scale = 1000000, duration = null, durationBytes = 8, seekHead = false, knownSegment = false, cluster = true } = {}) => {
      const ebml = el(0x1a45dfa3, el(0x4282, [0x77, 0x65, 0x62, 0x6d])); // DocType "webm"
      let info = [...el(0x2ad7b1, uint(scale, 3)), ...el(0x4d80, [0x74, 0x65, 0x73, 0x74])]; // TimecodeScale, MuxingApp
      if (duration !== null) info = info.concat(el(0x4489, durationBytes === 8 ? float64(duration) : float32(duration)));
      let body = [];
      if (seekHead) body = body.concat(el(0x114d9b74, [0xec, 0x80]));
      body = body.concat(el(0x1549a966, info, 8)); // Info, as Chrome writes it: an 8-byte size
      body = body.concat(el(0x1654ae6b, [0xae, 0x80])); // Tracks
      if (cluster) body = body.concat(el(0x1f43b675, [0xe7, 0x81, 0x00, 0xa3, 0x84, 0x81, 0x00, 0x00, 0x80]));
      const segSize = knownSegment ? vint(body.length, 8) : UNKNOWN;
      return new Blob([new Uint8Array([...ebml, ...id(0x18538067), ...segSize, ...body])], { type: 'video/webm' });
    };
    window.bytesOf = async (blob) => Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
});

after(async () => {
  await browser?.close();
  await server?.close();
});

test('webm: adds a missing Duration without disturbing the rest of the file', async () => {
  const r = await page.evaluate(async () => {
    const input = window.buildWebm();
    const out = await window.AVR.webm.fixDuration(input, 4321);
    const a = await window.bytesOf(input);
    const b = await window.bytesOf(out);
    // Everything after Info is byte-identical, just shifted by the new element.
    const tailA = a.slice(a.length - 20);
    const tailB = b.slice(b.length - 20);
    return { grew: b.length - a.length, duration: await window.AVR.webm.readDuration(out), sameTail: JSON.stringify(tailA) === JSON.stringify(tailB), type: out.type };
  });
  assert.equal(r.grew, 11); // ID (2) + size (1) + float64 (8)
  assert.equal(r.duration, 4321);
  assert.ok(r.sameTail);
  assert.equal(r.type, 'video/webm');
});

test('webm: overwrites an existing Duration in place (8 and 4 bytes)', async () => {
  const r = await page.evaluate(async () => {
    const out = {};
    for (const size of [8, 4]) {
      const input = window.buildWebm({ duration: 0, durationBytes: size });
      const fixed = await window.AVR.webm.fixDuration(input, 1500);
      out[size] = { sameLength: fixed.size === input.size, duration: await window.AVR.webm.readDuration(fixed) };
    }
    return out;
  });
  assert.deepEqual(r[8], { sameLength: true, duration: 1500 });
  assert.equal(r[4].sameLength, true);
  assert.ok(Math.abs(r[4].duration - 1500) < 0.01);
});

test('webm: respects a non-default TimecodeScale', async () => {
  const r = await page.evaluate(async () => {
    const fixed = await window.AVR.webm.fixDuration(window.buildWebm({ scale: 500000 }), 2000);
    return window.AVR.webm.readDuration(fixed);
  });
  assert.equal(r, 2000);
});

test('webm: adjusts a Segment with a known size', async () => {
  const r = await page.evaluate(async () => {
    const input = window.buildWebm({ knownSegment: true });
    const fixed = await window.AVR.webm.fixDuration(input, 999);
    const b = new Uint8Array(await fixed.arrayBuffer());
    // EBML header: 12 bytes. Segment ID: 4. Then an 8-byte size (marker byte + 7 value bytes).
    let size = 0;
    for (let i = 17; i < 24; i++) size = size * 256 + b[i];
    return { declared: size, actual: b.length - 24, duration: await window.AVR.webm.readDuration(fixed) };
  });
  assert.equal(r.declared, r.actual);
  assert.equal(r.duration, 999);
});

test('webm: leaves files it cannot safely patch exactly as they were', async () => {
  const r = await page.evaluate(async () => {
    const same = async (blob, ms) => (await window.AVR.webm.fixDuration(blob, ms)) === blob;
    return {
      // A SeekHead holds byte offsets that inserting would break.
      seekHead: await same(window.buildWebm({ seekHead: true }), 1000),
      notWebm: await same(new Blob([new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70])]), 1000),
      empty: await same(new Blob([]), 1000),
      zeroDuration: await same(window.buildWebm(), 0),
      truncated: await same(new Blob([(await window.bytesOf(window.buildWebm())).slice(0, 30)].map((a) => new Uint8Array(a))), 1000),
      garbage: await same(new Blob([new Uint8Array(512).map((_, i) => (i * 37) & 0xff)]), 1000),
    };
  });
  assert.deepEqual(r, { seekHead: true, notWebm: true, empty: true, zeroDuration: true, truncated: true, garbage: true });
});

test('webm: a SeekHead file that already has a Duration is still updated in place', async () => {
  const r = await page.evaluate(async () => {
    const input = window.buildWebm({ seekHead: true, duration: 0 });
    const fixed = await window.AVR.webm.fixDuration(input, 777);
    return { sameLength: fixed.size === input.size, duration: await window.AVR.webm.readDuration(fixed) };
  });
  assert.deepEqual(r, { sameLength: true, duration: 777 });
});

test('webm: patches a header split across chunks, as Chrome delivers it when the first frame is late', async () => {
  const r = await page.evaluate(async () => {
    // Chrome's real output in this case: the first chunk is one byte (0x1A).
    const file = new Uint8Array([...(await window.bytesOf(window.buildWebm())), ...new Uint8Array(400 * 1024)]);
    const cuts = [1, 20, 100 * 1024, 200 * 1024, 300 * 1024, file.length];
    const chunks = [];
    for (let i = 0, from = 0; i < cuts.length; from = cuts[i], i++) chunks.push(new Blob([file.slice(from, cuts[i])], { type: 'video/webm' }));
    const fixed = await window.AVR.webm.fixDurationInChunks(chunks, 5000);
    const whole = new Blob(fixed.blobs, { type: 'video/webm' });
    return {
      count: fixed.blobs.length,
      changed: fixed.changed,
      duration: await window.AVR.webm.readDuration(whole),
      grew: whole.size - file.length,
      // Chunks past the header region are the very same Blobs, untouched.
      untouched: fixed.blobs.slice(fixed.changed.length).every((b, i) => b === chunks[fixed.changed.length + i]),
      emptied: fixed.changed.slice(1).every((i) => fixed.blobs[i].size === 0),
      singleByteAlone: await window.AVR.webm.fixDuration(chunks[0], 5000) === chunks[0],
    };
  });
  assert.equal(r.count, 6, 'chunk count is preserved');
  assert.deepEqual(r.changed, [0, 1, 2, 3, 4]); // chunks covering the first 256 KB
  assert.equal(r.duration, 5000);
  assert.equal(r.grew, 11);
  assert.ok(r.untouched);
  assert.ok(r.emptied);
  assert.ok(r.singleByteAlone, 'a lone first byte cannot be patched by itself; that was the bug');
});

test('formats: bitrates follow YouTube recommendations and scale with quality', async () => {
  const r = await page.evaluate(() => {
    const b = window.AVR.formats.videoBitrate;
    return {
      p720: b(1280, 720, 30, 'high'),
      p720x60: b(1280, 720, 60, 'high'),
      p1080: b(1920, 1080, 30, 'high'),
      p1080x60: b(1920, 1080, 60, 'high'),
      p1440: b(2560, 1440, 30, 'high'),
      p2160: b(3840, 2160, 30, 'high'),
      p2160x60: b(3840, 2160, 60, 'high'),
      portrait1080: b(1080, 1920, 30, 'high'),
      standard: b(1920, 1080, 30, 'standard'),
      max: b(1920, 1080, 30, 'max'),
      tiny: b(320, 240, 30, 'standard'),
      audioStd: window.AVR.formats.audioBitrate('standard'),
      audioHigh: window.AVR.formats.audioBitrate('high'),
    };
  });
  assert.equal(r.p720, 5e6);
  assert.equal(r.p720x60, 7.5e6);
  assert.equal(r.p1080, 8e6);
  assert.equal(r.p1080x60, 12e6);
  assert.equal(r.p1440, 16e6);
  assert.equal(r.p2160, 35e6);
  assert.equal(r.p2160x60, 53e6);
  assert.equal(r.portrait1080, 8e6); // Shorts are judged by their long side
  assert.equal(r.standard, 4e6);
  assert.equal(r.max, 12.8e6);
  assert.equal(r.tiny, 1e6); // never below the floor
  assert.equal(r.audioStd, 128000);
  assert.equal(r.audioHigh, 192000);
});

test('formats: file extensions and container types match what was recorded', async () => {
  const r = await page.evaluate(() => {
    const f = window.AVR.formats;
    return [
      f.extFor('video/mp4;codecs=avc1,mp4a.40.2', 'video'), f.extFor('audio/mp4', 'audio'), f.extFor('video/mp4', 'audio'),
      f.extFor('video/webm;codecs=vp9,opus', 'video'), f.extFor('audio/webm;codecs=opus', 'audio'),
      f.extFor('audio/ogg;codecs=opus', 'audio'), f.extFor('', 'video'), f.extFor('video/quicktime', 'video'),
      f.baseType('video/webm;codecs=vp9,opus', 'video'), f.baseType('', 'audio'), f.baseType('', 'video'),
      f.presetSize('720').long, f.presetSize('2160').short,
    ];
  });
  assert.deepEqual(r, ['mp4', 'm4a', 'm4a', 'webm', 'webm', 'ogg', 'webm', 'mp4', 'video/webm', 'audio/webm', 'video/webm', 1280, 2160]);
});

test('wav: writes a valid 16-bit PCM file with clipped samples', async () => {
  const r = await page.evaluate(async () => {
    const ctx = new OfflineAudioContext(2, 48000, 48000);
    const buf = ctx.createBuffer(2, 4, 48000);
    buf.getChannelData(0).set([0, 0.5, -1, 2]); // 2 must clip to full scale
    buf.getChannelData(1).set([0, -0.5, 1, -2]);
    const wav = new Uint8Array(await window.AVR.wav.encode(buf).arrayBuffer());
    const v = new DataView(wav.buffer);
    const text = (o) => String.fromCharCode(...wav.slice(o, o + 4));
    const samples = [];
    for (let o = 44; o < wav.length; o += 2) samples.push(v.getInt16(o, true));
    return {
      riff: text(0), wave: text(8), fmt: text(12), data: text(36),
      riffSize: v.getUint32(4, true), format: v.getUint16(20, true), channels: v.getUint16(22, true),
      rate: v.getUint32(24, true), byteRate: v.getUint32(28, true), align: v.getUint16(32, true),
      bits: v.getUint16(34, true), dataSize: v.getUint32(40, true), length: wav.length, samples,
    };
  });
  assert.equal(r.riff, 'RIFF');
  assert.equal(r.wave, 'WAVE');
  assert.equal(r.fmt, 'fmt ');
  assert.equal(r.data, 'data');
  assert.equal(r.format, 1);
  assert.equal(r.channels, 2);
  assert.equal(r.rate, 48000);
  assert.equal(r.byteRate, 48000 * 4);
  assert.equal(r.align, 4);
  assert.equal(r.bits, 16);
  assert.equal(r.dataSize, 16);
  assert.equal(r.riffSize, 36 + 16);
  assert.equal(r.length, 44 + 16);
  // Interleaved L/R: 0,0 | 0.5,-0.5 | -1,1 | 2,-2 (clipped)
  assert.deepEqual(r.samples, [0, 0, 16383, -16384, -32768, 32767, 32767, -32768]);
});

test('util: durations, sizes, dates and file names are formatted safely', async () => {
  const r = await page.evaluate(() => {
    const A = window.AVR;
    return {
      durations: [0, 999, 1000, 61000, 3599000, 3600000, 36610000, -5].map(A.formatDuration),
      bytes: [0, 512, 1536, 5 * 1024 * 1024, 1.5 * 1024 ** 3].map(A.formatBytes),
      stamp: A.stamp(new Date(2026, 0, 2, 3, 4, 5)),
      names: ['Camera 2026-01-02', 'a/b\\c:d*e?f"g<h>i|j', '   ', 'x'.repeat(300), 'Tab\there'].map(A.safeFilename),
      escaped: A.escapeHtml('<img src=x onerror="a">&\''),
    };
  });
  assert.deepEqual(r.durations, ['00:00', '00:00', '00:01', '01:01', '59:59', '1:00:00', '10:10:10', '00:00']);
  assert.deepEqual(r.bytes, ['0 B', '512 B', '1.5 KB', '5.0 MB', '1.5 GB']);
  assert.equal(r.stamp, '2026-01-02 03-04-05');
  assert.equal(r.names[0], 'Camera 2026-01-02');
  assert.equal(r.names[1], 'a-b-c-d-e-f-g-h-i-j');
  assert.equal(r.names[2], 'Recording');
  assert.equal(r.names[3].length, 120);
  assert.equal(r.names[4], 'Tab-here');
  assert.equal(r.escaped, '&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;');
});
