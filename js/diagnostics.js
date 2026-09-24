// A small on-device event log plus a diagnostics report.
//
// There is no server, so when something goes wrong on someone's phone the
// only record is what the page keeps itself. Notable events and every uncaught
// error go into a ring buffer in localStorage. Help → Diagnostics shows it with
// the browser's capabilities, ready to copy into a bug report. Nothing is ever
// sent anywhere automatically.
(function (AVR) {
  'use strict';

  var KEY = 'avr.log.v1';
  var MAX = 80;
  var entries = [];
  var timer = null;

  try {
    var saved = JSON.parse(window.localStorage.getItem(KEY) || '[]');
    if (Array.isArray(saved)) entries = saved.slice(-MAX);
  } catch (e) { /* unreadable log: start fresh */ }

  function flush() {
    clearTimeout(timer);
    try { window.localStorage.setItem(KEY, JSON.stringify(entries)); } catch (e) { /* storage full or blocked */ }
  }

  // level: 'info' | 'warn' | 'error'
  function log(level, event, detail) {
    var entry = { t: Date.now(), level: level, event: String(event) };
    if (detail !== undefined && detail !== null) {
      var text = detail instanceof Error || (detail && detail.name && detail.message)
        ? detail.name + ': ' + detail.message
        : typeof detail === 'string' ? detail : JSON.stringify(detail);
      entry.detail = String(text).slice(0, 400);
    }
    entries.push(entry);
    if (entries.length > MAX) entries.splice(0, entries.length - MAX);
    clearTimeout(timer);
    timer = setTimeout(flush, 400);
    if (level !== 'info' && window.console) {
      // console.warn, not console.error: an expected failure such as a
      // refused permission is worth seeing, not worth an error.
      console.warn('[AV Recorder] ' + event + (entry.detail ? ': ' + entry.detail : ''));
    }
  }

  window.addEventListener('error', function (e) {
    var where = e.filename ? ' @ ' + String(e.filename).split('/').pop() + ':' + e.lineno : '';
    log('error', 'uncaught', (e.message || 'error') + where);
  });
  window.addEventListener('unhandledrejection', function (e) {
    log('error', 'unhandled-rejection', e.reason || 'unknown');
  });
  window.addEventListener('pagehide', flush);

  function yes(v) { return v ? 'yes' : 'no'; }

  // A plain-text report. It holds no recordings, script text or device names.
  function report() {
    var P = AVR.platform || {};
    var S = AVR.settings || {};
    var f = AVR.formats;
    var lines = [
      'AV Recorder ' + AVR.VERSION,
      'Time: ' + new Date().toISOString(),
      'Browser: ' + navigator.userAgent,
      'Screen: ' + window.screen.width + 'x' + window.screen.height + ' @' + (window.devicePixelRatio || 1) + 'x',
      'Secure page: ' + yes(P.secure) + '  Online: ' + yes(navigator.onLine !== false),
      'Camera/mic API: ' + yes(P.hasMedia) + '  Recorder: ' + yes(P.hasRecorder) + '  Screen capture: ' + yes(P.canCaptureScreen),
      'Wake lock: ' + yes(P.hasWakeLock) + '  Floating window: ' + yes(P.hasDocumentPip) + '  Web Locks: ' + yes(navigator.locks) +
        '  Share files: ' + yes(P.canShareFiles),
      'Offline worker: ' + yes(navigator.serviceWorker && navigator.serviceWorker.controller),
      'Video formats: ' + (f ? f.list('video').map(function (x) { return x.label; }).join(', ') || 'none' : '?'),
      'Audio formats: ' + (f ? f.list('audio').map(function (x) { return x.label; }).join(', ') || 'none' : '?'),
      'Settings: mode=' + S.mode + ' resolution=' + S.resolution + ' fps=' + S.fps + ' quality=' + S.quality +
        ' videoFormat=' + S.videoFormat + ' audioFormat=' + S.audioFormat + ' aspect=' + S.aspect,
    ];
    var storage = AVR.store ? AVR.store.status() : Promise.resolve(null);
    return storage.then(function (st) {
      if (st) {
        lines.push('Storage: ' + (st.available ? 'available' : 'unavailable') +
          (st.quota ? ', ' + AVR.formatBytes(st.usage) + ' used of ' + AVR.formatBytes(st.quota) : '') +
          ', protected from cleanup: ' + yes(st.persisted));
      }
      lines.push('', 'Recent events (oldest first):');
      if (!entries.length) lines.push('  none');
      entries.forEach(function (e) {
        lines.push('  ' + new Date(e.t).toISOString().slice(5, 19).replace('T', ' ') + ' ' + e.level.toUpperCase() +
          ' ' + e.event + (e.detail ? ': ' + e.detail : ''));
      });
      return lines.join('\n');
    });
  }

  AVR.log = log;
  AVR.logEntries = function () { return entries.slice(); };
  AVR.diagnosticsReport = report;
})(window.AVR = window.AVR || {});
