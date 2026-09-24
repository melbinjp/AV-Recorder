// Checks on the source itself (no browser): invariants that are easy to break
// by accident and hard to notice until a user hits them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { ROOT } from './helpers.mjs';

const read = (p) => readFile(path.join(ROOT, p), 'utf8');
const exists = (p) => stat(path.join(ROOT, p)).then(() => true, () => false);

async function shellList() {
  const sw = await read('sw.js');
  const block = sw.match(/var SHELL = \[([\s\S]*?)\];/);
  assert.ok(block, 'sw.js must define SHELL');
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

// Local files the page loads: scripts, stylesheets, icons, manifest.
async function pageAssets() {
  const html = await read('index.html');
  const refs = [...html.matchAll(/<(?:script|link)\b[^>]*?(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  const local = refs.filter((r) => !/^(https?:)?\/\//.test(r));
  const manifest = JSON.parse(await read('manifest.webmanifest'));
  return [...new Set([...local, ...manifest.icons.map((i) => i.src)])];
}

test('every file the page loads is cached for offline use, and every cached file exists', async () => {
  const shell = await shellList();
  for (const asset of await pageAssets()) {
    assert.ok(shell.includes(asset), `${asset} is loaded by the page but missing from SHELL in sw.js`);
  }
  for (const file of shell) {
    if (file === './') continue;
    assert.ok(await exists(file), `SHELL lists ${file}, which does not exist`);
  }
  // And every script in js/ is actually loaded (no dead files shipping).
  const scripts = (await readdir(path.join(ROOT, 'js'))).filter((f) => f.endsWith('.js'));
  const html = await read('index.html');
  for (const s of scripts) assert.ok(html.includes(`src="js/${s}"`), `js/${s} is never loaded`);
});

test('the Content-Security-Policy allows exactly the inline scripts on the page', async () => {
  const html = await read('index.html');
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
  assert.ok(csp, 'index.html must declare a Content-Security-Policy');
  const allowed = [...csp[1].matchAll(/'sha256-([^']+)'/g)].map((m) => m[1]);
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) =>
    createHash('sha256').update(m[1]).digest('base64'));
  assert.deepEqual(inline.sort(), allowed.sort(), 'update the sha256 in the CSP to match the inline script(s)');
  assert.doesNotMatch(csp[1], /unsafe-inline|unsafe-eval/);
  // The CSP forbids inline styles and handlers, so the markup must not use them.
  assert.doesNotMatch(html, /\sstyle="/, 'inline style attribute in index.html');
  assert.doesNotMatch(html, /\son[a-z]+="/, 'inline event handler in index.html');
});

test('every element the scripts look up exists, and ids are unique', async () => {
  const html = await read('index.html');
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(dupes, [], 'duplicate ids in index.html');
  const idSet = new Set(ids);

  const wanted = new Set();
  for (const f of (await readdir(path.join(ROOT, 'js'))).filter((x) => x.endsWith('.js') && x !== 'icons.js')) {
    const src = await read('js/' + f);
    for (const m of src.matchAll(/getElementById\('([^']+)'\)/g)) wanted.add(m[1]);
    // Lists of ids collected in one go (var ids = [...]).
    for (const block of src.matchAll(/var ids = \[([\s\S]*?)\];/g)) {
      for (const m of block[1].matchAll(/'([^']+)'/g)) wanted.add(m[1]);
    }
  }
  const missing = [...wanted].filter((id) => !idSet.has(id) && id !== 'icon-sprite');
  assert.deepEqual(missing, [], 'scripts look up ids that index.html does not have');
});

test('the app stays small', async () => {
  const shell = (await shellList()).filter((f) => f !== './');
  let code = '';
  let total = 0;
  for (const f of shell) {
    const buf = await readFile(path.join(ROOT, f));
    total += buf.length;
    if (/\.(html|css|js|webmanifest)$/.test(f)) code += buf.toString('utf8');
  }
  const gz = gzipSync(code, { level: 9 }).length;
  // About 25% above today's size: room to grow, but a bundled library or a
  // stray large asset fails here instead of slowing every visit.
  const KB = 1024;
  assert.ok(code.length < 380 * KB, `code is ${Math.round(code.length / KB)} KB (budget 380 KB)`);
  assert.ok(gz < 100 * KB, `code is ${Math.round(gz / KB)} KB gzipped (budget 100 KB)`);
  assert.ok(total < 700 * KB, `everything cached for offline is ${Math.round(total / KB)} KB (budget 700 KB)`);
});

test('the version is set once and has a changelog entry', async () => {
  const src = await read('js/version.js');
  const m = src.match(/AVR_VERSION = '(\d+\.\d+\.\d+)'/);
  assert.ok(m, 'js/version.js must set a semantic version');
  const changelog = await read('CHANGELOG.md');
  assert.match(changelog, new RegExp(`^## ${m[1].replace(/\./g, '\\.')} `, 'm'), `CHANGELOG.md needs a "## ${m[1]}" entry`);
  // The service worker takes its cache name from the same file.
  assert.match(await read('sw.js'), /importScripts\('js\/version\.js'\)/);
});
