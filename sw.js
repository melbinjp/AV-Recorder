// Service worker: makes the recorder load with no connection and installable
// as an app.
//
// Strategy: network first, cache as fallback. Online you always get the latest
// version (no stale page mixed with newer scripts); offline, the last good copy
// is served. The app shell is pre-cached on install so the very first offline
// visit works too. Bump VERSION when the list of files changes.
var VERSION = 'avr-v2';
var SHELL = [
  './',
  'index.html',
  'style.css',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'js/icons.js',
  'js/util.js',
  'js/settings.js',
  'js/store.js',
  'js/formats.js',
  'js/webm-duration.js',
  'js/wav.js',
  'js/audio-engine.js',
  'js/compositor.js',
  'js/session.js',
  'js/teleprompter.js',
  'js/pip.js',
  'js/library.js',
  'js/app.js',
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(VERSION).then(function (cache) {
      // cache: 'reload' skips the HTTP cache so the shell is truly current.
      return cache.addAll(SHELL.map(function (url) { return new Request(url, { cache: 'reload' }); }));
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k.indexOf('avr-') === 0 && k !== VERSION; }).map(function (k) {
        return caches.delete(k);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Media range requests (seeking in <video>) must go straight to the network.
  if (req.headers.has('range')) return;

  event.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok && res.type === 'basic') {
        var copy = res.clone();
        caches.open(VERSION).then(function (cache) { cache.put(req, copy); }).catch(function () {});
      }
      return res;
    }).catch(function () {
      return caches.match(req, { ignoreSearch: true }).then(function (hit) {
        if (hit) return hit;
        if (req.mode === 'navigate') return caches.match('index.html');
        return new Response('', { status: 504, statusText: 'Offline' });
      });
    })
  );
});
