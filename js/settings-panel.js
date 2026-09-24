// The settings sidebar: binds every control to AVR.settings, saves changes,
// and tells the app when something needs acting on. It never touches media.
(function (AVR) {
  'use strict';

  var $$ = AVR.$$;
  var S = AVR.settings;
  var P = AVR.platform;

  // handlers: videoChanged(), deviceChanged(kind), micProcessingChanged(),
  //   mirrorChanged(), systemAudioChanged(), micGainChanged(gain),
  //   bubbleChanged(), prompterVisibilityChanged(visible), qualityChanged(),
  //   outputSize() → {width, height} | null
  function SettingsPanel(prompter, handlers) {
    this.prompter = prompter;
    this.h = handlers;
    var ids = [
      'videoSource', 'audioSource', 'mirrorCamera', 'systemAudio', 'systemAudioHint', 'permissionHint',
      'resolution', 'fps', 'quality', 'aspect', 'videoFormat', 'audioFormat', 'qualityHint', 'micGain',
      'micGainValue', 'noiseSuppression', 'echoCancellation', 'autoGainControl', 'prompterVisible',
      'prompterScript', 'prompterSpeed', 'prompterSpeedValue', 'prompterSize', 'prompterSizeValue',
      'prompterAutoStart', 'prompterMirror', 'prompterSettings', 'countdown', 'countdownBeep',
      'floatingControls', 'floatingControlsField',
    ];
    var els = {};
    ids.forEach(function (id) { els[id] = document.getElementById(id); });
    this.els = els;
    this.bind();
    this.populateFormats();
    this.updateSystemAudioHint();
    this.updateQualityHint();
  }

  SettingsPanel.prototype.bind = function () {
    var self = this;
    var e = this.els;
    var h = this.h;

    function select(el, key, parse, after) {
      el.value = String(S[key]);
      if (el.value !== String(S[key]) && el.options.length) S[key] = parse(el.value);
      el.addEventListener('change', function () {
        S[key] = parse(el.value);
        AVR.saveSettings();
        if (after) after();
      });
    }
    function check(el, obj, key, after) {
      el.checked = !!obj[key];
      el.addEventListener('change', function () {
        obj[key] = el.checked;
        AVR.saveSettings();
        if (after) after();
      });
    }
    var str = function (v) { return v; };
    var num = function (v) { return Number(v); };
    var videoChanged = function () { self.updateQualityHint(); h.videoChanged(); };

    select(e.resolution, 'resolution', str, videoChanged);
    select(e.fps, 'fps', num, videoChanged);
    select(e.aspect, 'aspect', str, videoChanged);
    select(e.quality, 'quality', str, function () { self.updateQualityHint(); h.qualityChanged(); });
    select(e.countdown, 'countdown', num);

    e.videoSource.addEventListener('change', function () {
      S.videoDeviceId = e.videoSource.value;
      AVR.saveSettings();
      h.deviceChanged('cam');
    });
    e.audioSource.addEventListener('change', function () {
      S.audioDeviceId = e.audioSource.value;
      AVR.saveSettings();
      h.deviceChanged('mic');
    });

    check(e.mirrorCamera, S, 'mirror', h.mirrorChanged);
    check(e.systemAudio, S, 'systemAudio', h.systemAudioChanged);
    ['noiseSuppression', 'echoCancellation', 'autoGainControl'].forEach(function (key) {
      check(e[key], S, key, h.micProcessingChanged);
    });
    check(e.countdownBeep, S, 'countdownBeep');
    check(e.floatingControls, S, 'floatingControls');
    e.floatingControlsField.hidden = !AVR.FloatingControls.supported();

    e.micGain.value = Math.round(S.micGain * 100);
    e.micGainValue.textContent = e.micGain.value + '%';
    e.micGain.addEventListener('input', function () {
      S.micGain = Number(e.micGain.value) / 100;
      e.micGainValue.textContent = e.micGain.value + '%';
      AVR.saveSettings();
      h.micGainChanged(S.micGain);
    });

    // Teleprompter: the on-stage toolbar and these controls edit the same
    // settings, so each keeps the other in step.
    var p = S.prompter;
    var prompter = this.prompter;
    e.prompterScript.value = p.text;
    e.prompterScript.addEventListener('input', function () {
      p.text = e.prompterScript.value;
      prompter.setText(p.text);
      AVR.saveSettings();
    });
    check(e.prompterVisible, p, 'visible', function () { h.prompterVisibilityChanged(p.visible); });
    check(e.prompterAutoStart, p, 'autoStart');
    check(e.prompterMirror, p, 'mirror', function () { prompter.applyStyle(); });
    e.prompterSpeed.addEventListener('input', function () { prompter.setSpeed(Number(e.prompterSpeed.value)); });
    e.prompterSize.addEventListener('input', function () { prompter.setFontSize(Number(e.prompterSize.value)); });
    prompter.onStyleChange = function () { self.syncPrompter(); };
    this.syncPrompter();

    // Camera bubble
    $$('.segmented[data-setting]').forEach(function (group) {
      var path = group.getAttribute('data-setting').split('.');
      function sync() {
        $$('button', group).forEach(function (b) {
          b.setAttribute('aria-checked', String(S[path[0]][path[1]] === b.getAttribute('data-value')));
        });
      }
      group.addEventListener('click', function (ev) {
        var b = ev.target.closest ? ev.target.closest('button[data-value]') : null;
        if (!b) return;
        S[path[0]][path[1]] = b.getAttribute('data-value');
        AVR.saveSettings();
        sync();
        h.bubbleChanged();
      });
      sync();
    });
    $$('.corner-picker button').forEach(function (b) {
      b.addEventListener('click', function () {
        var xy = b.getAttribute('data-corner').split(',');
        S.bubble.x = Number(xy[0]);
        S.bubble.y = Number(xy[1]);
        AVR.saveSettings();
        h.bubbleChanged();
      });
    });
  };

  SettingsPanel.prototype.syncPrompter = function () {
    var e = this.els;
    var p = S.prompter;
    e.prompterSpeed.value = p.speed;
    e.prompterSize.value = p.fontSize;
    e.prompterSpeedValue.textContent = String(p.speed);
    e.prompterSizeValue.textContent = p.fontSize + 'px';
    e.prompterMirror.checked = !!p.mirror;
    e.prompterVisible.checked = !!p.visible;
  };

  SettingsPanel.prototype.populateFormats = function () {
    var e = this.els;
    [['video', e.videoFormat, 'videoFormat'], ['audio', e.audioFormat, 'audioFormat']].forEach(function (row) {
      var kind = row[0];
      var el = row[1];
      var key = row[2];
      var list = AVR.formats.list(kind);
      el.innerHTML = '';
      var auto = document.createElement('option');
      auto.value = 'auto';
      auto.textContent = list.length ? 'Best for this device (' + list[0].label + ')' : 'Browser default';
      el.appendChild(auto);
      list.forEach(function (f) {
        var o = document.createElement('option');
        o.value = f.mime;
        o.textContent = f.label;
        el.appendChild(o);
      });
      el.value = S[key];
      if (el.value !== S[key]) {
        el.value = 'auto';
        S[key] = 'auto';
      }
      el.addEventListener('change', function () {
        S[key] = el.value;
        AVR.saveSettings();
      });
    });
  };

  SettingsPanel.prototype.updateSystemAudioHint = function () {
    this.els.systemAudioHint.textContent = (P.isFirefox || P.isSafari)
      ? 'This browser can record your microphone but not sound playing on the computer. Use Chrome or Edge for that.'
      : 'In the sharing dialog, tick "Share audio" (for a tab, or the whole screen on Windows).';
  };

  SettingsPanel.prototype.updateQualityHint = function () {
    var actual = this.h.outputSize();
    var preset = AVR.formats.presetSize(S.resolution);
    var size = actual || { width: preset.long, height: preset.short };
    var bits = AVR.formats.videoBitrate(size.width, size.height, S.fps, S.quality) + AVR.formats.audioBitrate(S.quality);
    this.els.qualityHint.textContent = 'About ' + AVR.formatBytes((bits / 8) * 60) + ' per minute at most' +
      (actual ? ' (' + size.width + '×' + size.height + ')' : '') + '. Simple screens and still shots use much less.';
  };

  // Fills the device pickers from Sources.enumerate().
  SettingsPanel.prototype.setDevices = function (list) {
    var e = this.els;
    e.permissionHint.hidden = list.labelled || !list.any;

    function fill(select, devices, defaultLabel, prefix, extra) {
      select.innerHTML = '';
      var def = document.createElement('option');
      def.value = '';
      def.textContent = defaultLabel;
      select.appendChild(def);
      devices.forEach(function (d, i) {
        var o = document.createElement('option');
        o.value = d.deviceId;
        o.textContent = d.label || prefix + ' ' + (i + 1);
        select.appendChild(o);
      });
      (extra || []).forEach(function (x) {
        var o = document.createElement('option');
        o.value = x.value;
        o.textContent = x.label;
        select.appendChild(o);
      });
    }
    fill(e.videoSource, list.cams, P.isMobile ? 'Default (use Flip to switch)' : 'Default camera', 'Camera');
    fill(e.audioSource, list.mics, 'Default microphone', 'Microphone', [{ value: 'none', label: 'No microphone' }]);
    this.syncDevices();
  };

  // Shows the saved choices; a device that is no longer present shows as Default.
  SettingsPanel.prototype.syncDevices = function () {
    var e = this.els;
    e.videoSource.value = S.videoDeviceId;
    if (e.videoSource.value !== S.videoDeviceId) e.videoSource.value = '';
    e.audioSource.value = S.audioDeviceId;
    if (e.audioSource.value !== S.audioDeviceId) e.audioSource.value = '';
    e.mirrorCamera.checked = !!S.mirror;
  };

  // Settings that cannot change while recording (or while a source starts).
  SettingsPanel.prototype.lock = function (locked, micGainLocked) {
    var e = this.els;
    [e.videoSource, e.audioSource, e.resolution, e.fps, e.quality, e.aspect, e.videoFormat, e.audioFormat,
      e.noiseSuppression, e.echoCancellation, e.autoGainControl, e.systemAudio].forEach(function (el) {
      el.disabled = locked;
    });
    e.micGain.disabled = !!micGainLocked;
  };

  SettingsPanel.prototype.openPrompterEditor = function () {
    var e = this.els;
    e.prompterSettings.open = true;
    e.prompterScript.focus();
    e.prompterSettings.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  AVR.SettingsPanel = SettingsPanel;
})(window.AVR = window.AVR || {});
