// User preferences, remembered in localStorage. Every read is validated against
// the defaults, so a corrupt or outdated entry can never stop the app loading.
(function (AVR) {
  'use strict';

  var KEY = 'avr.settings.v1';

  var DEFAULTS = {
    mode: 'camera', // camera | screen | screencam | audio
    videoDeviceId: '',
    audioDeviceId: '', // '' = system default, 'none' = no microphone
    facingMode: 'user',
    mirror: true,
    resolution: '1080', // 720 | 1080 | 1440 | 2160
    fps: 30,
    quality: 'high', // standard | high | max
    videoFormat: 'auto',
    audioFormat: 'auto',
    aspect: 'auto', // camera only: auto | 16:9 | 9:16 | 1:1
    systemAudio: true,
    micGain: 1,
    noiseSuppression: true,
    echoCancellation: true,
    autoGainControl: true,
    countdown: 3,
    countdownBeep: true,
    floatingControls: true,
    bubble: { size: 'm', shape: 'circle', x: 1, y: 1 },
    prompter: { visible: false, text: '', speed: 3, fontSize: 32, mirror: false, autoStart: true },
  };

  var ENUMS = {
    mode: ['camera', 'screen', 'screencam', 'audio'],
    facingMode: ['user', 'environment'],
    resolution: ['720', '1080', '1440', '2160'],
    fps: [24, 30, 60],
    quality: ['standard', 'high', 'max'],
    aspect: ['auto', '16:9', '9:16', '1:1'],
    countdown: [0, 3, 5, 10],
  };

  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  function merge(defaults, saved) {
    var out = clone(defaults);
    if (!saved || typeof saved !== 'object') return out;
    Object.keys(defaults).forEach(function (key) {
      var def = defaults[key];
      var val = saved[key];
      if (val === undefined || val === null) return;
      if (def && typeof def === 'object') {
        out[key] = merge(def, val);
      } else if (typeof val === typeof def) {
        if (ENUMS[key] && ENUMS[key].indexOf(val) === -1) return;
        out[key] = val;
      }
    });
    return out;
  }

  function load() {
    try {
      var raw = window.localStorage.getItem(KEY);
      return merge(DEFAULTS, raw ? JSON.parse(raw) : null);
    } catch (e) {
      return clone(DEFAULTS);
    }
  }

  var settings = load();
  settings.micGain = Math.min(3, Math.max(0, Number(settings.micGain) || 1));
  settings.prompter.speed = Math.min(10, Math.max(1, Number(settings.prompter.speed) || 3));
  settings.prompter.fontSize = Math.min(72, Math.max(16, Number(settings.prompter.fontSize) || 32));
  settings.bubble.x = Math.min(1, Math.max(0, Number(settings.bubble.x)));
  settings.bubble.y = Math.min(1, Math.max(0, Number(settings.bubble.y)));

  var timer = null;
  function save() {
    clearTimeout(timer);
    timer = setTimeout(flush, 200);
  }
  function flush() {
    clearTimeout(timer);
    try { window.localStorage.setItem(KEY, JSON.stringify(settings)); } catch (e) { /* private mode or full */ }
  }
  window.addEventListener('pagehide', flush);

  AVR.settings = settings;
  AVR.saveSettings = save;
  AVR.settingsDefaults = DEFAULTS;
})(window.AVR = window.AVR || {});
