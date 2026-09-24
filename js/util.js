// Small shared helpers. Everything hangs off window.AVR so the app runs as plain
// scripts: no bundler, no modules, and it still works when opened from file://.
(function (AVR) {
  'use strict';

  var ua = navigator.userAgent || '';
  var isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var isAndroid = /Android/i.test(ua);
  var isMobile = isIOS || isAndroid || /Mobi|Silk|Kindle/i.test(ua);
  var md = navigator.mediaDevices;

  AVR.platform = {
    isIOS: isIOS,
    isAndroid: isAndroid,
    isMobile: isMobile,
    isSafari: /^((?!chrome|chromium|android|crios|fxios|edg).)*safari/i.test(ua),
    isFirefox: /firefox|fxios/i.test(ua),
    isMac: /Mac/.test(navigator.platform || '') && !isIOS,
    secure: window.isSecureContext !== false,
    hasMedia: !!(md && md.getUserMedia),
    hasRecorder: typeof window.MediaRecorder === 'function',
    // Phones and tablets have no screen capture in the browser, even where the
    // function exists, so treat them as unsupported rather than failing later.
    canCaptureScreen: !!(md && md.getDisplayMedia) && !isMobile,
    canShareFiles: !!(navigator.canShare && navigator.share),
    hasWakeLock: 'wakeLock' in navigator,
    hasDocumentPip: 'documentPictureInPicture' in window,
  };

  AVR.VERSION = self.AVR_VERSION || 'dev';

  AVR.$ = function (sel, root) { return (root || document).querySelector(sel); };
  AVR.$$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  AVR.icon = function (name, cls) {
    return '<svg class="icon' + (cls ? ' ' + cls : '') + '" aria-hidden="true"><use href="#i-' + name + '"></use></svg>';
  };

  AVR.escapeHtml = function (s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  AVR.formatDuration = function (ms) {
    var total = Math.max(0, Math.floor((ms || 0) / 1000));
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    return (h ? h + ':' + pad(m) : pad(m)) + ':' + pad(s);
  };

  AVR.formatBytes = function (n) {
    if (!n || n < 0) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    var v = n / Math.pow(1024, i);
    return (i === 0 || v >= 100 ? Math.round(v) : v.toFixed(1)) + ' ' + units[i];
  };

  AVR.formatDate = function (ts) {
    try {
      return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    } catch (e) {
      return new Date(ts).toISOString().slice(0, 16).replace('T', ' ');
    }
  };

  // "2026-09-24 15-30-12": sorts correctly and is legal in every file system.
  AVR.stamp = function (date) {
    var d = date || new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
      pad(d.getHours()) + '-' + pad(d.getMinutes()) + '-' + pad(d.getSeconds());
  };

  AVR.safeFilename = function (name) {
    var clean = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim();
    return (clean || 'Recording').slice(0, 120);
  };

  AVR.sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  AVR.withTimeout = function (promise, ms, fallback) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { resolve(fallback); }, ms);
      promise.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  };

  // Resolves once a <video> knows its frame size, so layout and canvas sizes
  // can be computed from real dimensions instead of guesses.
  AVR.waitForVideo = function (video, timeout) {
    return new Promise(function (resolve) {
      if (video.readyState >= 1 && video.videoWidth) return resolve(true);
      var done = false;
      function finish(ok) {
        if (done) return;
        done = true;
        video.removeEventListener('loadedmetadata', onMeta);
        video.removeEventListener('resize', onMeta);
        resolve(ok);
      }
      function onMeta() { if (video.videoWidth) finish(true); }
      video.addEventListener('loadedmetadata', onMeta);
      video.addEventListener('resize', onMeta);
      setTimeout(function () { finish(!!video.videoWidth); }, timeout || 4000);
    });
  };

  AVR.playSafely = function (media) {
    try {
      var p = media.play();
      if (p && p.catch) p.catch(function () {});
    } catch (e) { /* autoplay refusals are harmless for muted previews */ }
  };

  // The current frame of a <video> as a full-size PNG.
  AVR.frameToPng = function (video) {
    return new Promise(function (resolve, reject) {
      var w = video.videoWidth;
      var h = video.videoHeight;
      if (!w || !h) return reject(new Error('No picture'));
      var c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      c.getContext('2d').drawImage(video, 0, 0, w, h);
      c.toBlob(function (blob) {
        if (blob) resolve(blob);
        else reject(new Error('Could not encode the image'));
      }, 'image/png');
    });
  };

  AVR.downloadBlob = function (blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    // Revoking too early cancels large downloads in some browsers.
    setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 60000);
  };

  AVR.canShareFile = function (blob, filename) {
    if (!AVR.platform.canShareFiles || typeof File !== 'function') return false;
    try {
      return navigator.canShare({ files: [new File([blob], filename, { type: blob.type })] });
    } catch (e) {
      return false;
    }
  };

  AVR.shareFile = function (blob, filename, title) {
    var file = new File([blob], filename, { type: blob.type });
    return navigator.share({ files: [file], title: title || filename });
  };

  // Turns getUserMedia/getDisplayMedia failures into advice a person can act on.
  AVR.describeMediaError = function (err, what) {
    var name = (err && err.name) || '';
    var thing = what || 'camera or microphone';
    if (!AVR.platform.secure) return 'Recording needs a secure page. Open this app over https://.';
    switch (name) {
      case 'NotAllowedError':
      case 'PermissionDeniedError':
        if (what === 'screen') {
          if (err && /system/i.test(err.message || '') && AVR.platform.isMac) {
            return 'macOS blocked screen capture. Allow your browser in System Settings → Privacy & Security → Screen Recording, then restart the browser.';
          }
          return 'Screen sharing was cancelled or blocked.';
        }
        return 'Access to your ' + thing + ' is blocked. Allow it from the lock or camera icon in the address bar, then try again.';
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return 'No ' + thing + ' was found. Check that it is connected and enabled.';
      case 'NotReadableError':
      case 'TrackStartError':
        return 'Your ' + thing + ' is busy or blocked by the system. Close other apps that use it (video calls, other tabs) and try again.';
      case 'OverconstrainedError':
        return 'Your ' + thing + ' does not support the selected quality. Try a lower resolution.';
      case 'AbortError':
        return what === 'screen' ? 'Screen sharing was cancelled.' : 'Starting your ' + thing + ' was interrupted. Try again.';
      case 'SecurityError':
        return 'The browser blocked access to your ' + thing + ' on this page.';
      case 'NotSupportedError':
        return 'This browser cannot capture your ' + thing + '.';
      default:
        return 'Could not start your ' + thing + (err && err.message ? ': ' + err.message : '.');
    }
  };

  // Tells screen-reader users about a change they can't see (recording
  // started, paused, saved). Toasts are polite; this one is assertive.
  AVR.announce = function (text) {
    var el = document.getElementById('srStatus');
    if (!el) return;
    el.textContent = '';
    setTimeout(function () { el.textContent = text; }, 50);
  };

  // ---- Toasts -------------------------------------------------------------
  var ICONS = { success: 'check-circle-fill', error: 'warning-circle-fill', warning: 'warning-fill', info: 'info-fill' };

  AVR.toast = function (message, type, options) {
    var container = document.getElementById('toastContainer');
    if (!container) return;
    type = type || 'info';
    options = options || {};
    var el = document.createElement('div');
    el.className = 'toast ' + type;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.innerHTML = AVR.icon(ICONS[type] || ICONS.info) + '<span class="toast-msg"></span>';
    el.querySelector('.toast-msg').textContent = message;
    if (options.action) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toast-action';
      btn.textContent = options.action.label;
      btn.addEventListener('click', function () { options.action.onClick(); dismiss(); });
      el.appendChild(btn);
    }
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Dismiss');
    close.innerHTML = AVR.icon('x');
    close.addEventListener('click', dismiss);
    el.appendChild(close);

    // Keep at most four toasts so a burst of events cannot bury the screen.
    while (container.children.length >= 4) container.firstChild.remove();
    container.appendChild(el);
    void el.offsetWidth;
    el.classList.add('show');

    var timer = setTimeout(dismiss, options.timeout || (type === 'error' ? 8000 : 4000));
    function dismiss() {
      clearTimeout(timer);
      el.classList.remove('show');
      setTimeout(function () { el.remove(); }, 300);
    }
    return dismiss;
  };
})(window.AVR = window.AVR || {});
