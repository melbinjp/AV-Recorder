// The recorder: owns the capture sources, the preview, the recording session
// and the UI state. States:
//
//   idle → starting → preview → countdown → recording ⇄ paused → saving → review
//
// Design rules that keep it dependable:
//  - Record the plainest stream possible. Canvas compositing and audio mixing
//    are used only when a feature needs them.
//  - Every async start is tagged, so a slow permission prompt that resolves
//    after the person has moved on is cleaned up instead of hijacking the UI.
//  - Nothing that fails in a side feature (meter, thumbnail, wake lock, library,
//    floating window) may stop a recording.
(function (AVR) {
  'use strict';

  var $ = AVR.$;
  var $$ = AVR.$$;
  var S = AVR.settings;
  var P = AVR.platform;

  var MODES = {
    camera: {
      label: 'Camera', icon: 'video-camera', cam: true, screen: false,
      text: 'Preview your camera, check your framing, then hit record.', button: 'Start camera',
    },
    screen: {
      label: 'Screen', icon: 'monitor', cam: false, screen: true,
      text: 'Choose a screen, window or browser tab to record.', button: 'Choose what to share',
    },
    screencam: {
      label: 'Screen + Cam', icon: 'user-focus', cam: true, screen: true,
      text: 'Record your screen with your camera in a bubble you can drag anywhere.', button: 'Choose what to share',
    },
    audio: {
      label: 'Audio', icon: 'waveform', cam: false, screen: false,
      text: 'Record your voice: a voice-over, podcast or note.', button: 'Start microphone',
    },
  };

  var BASE_TITLE = document.title;
  var LIVE_STATES = { countdown: 1, recording: 1, paused: 1, saving: 1 };

  function stopStream(stream) {
    if (!stream) return;
    stream.getTracks().forEach(function (t) {
      try { t.stop(); } catch (e) { /* ignore */ }
    });
  }

  function firstTrack(stream, kind) {
    if (!stream) return null;
    var list = kind === 'audio' ? stream.getAudioTracks() : stream.getVideoTracks();
    return list[0] || null;
  }

  function aspectValue(aspect) {
    var parts = String(aspect).split(':');
    return parts.length === 2 ? Number(parts[0]) / Number(parts[1]) : 0;
  }

  function App() {
    this.state = 'idle';
    this.engine = new AVR.AudioEngine();
    this.src = { screen: null, cam: null, mic: null };
    this.srcVideos = { screen: null, cam: null };
    this.compositor = null;
    this.meter = null;
    this.mixer = null;
    this.session = null;
    this.review = null;
    this.muted = false;
    this.cameraHidden = false;
    this.autoPaused = false;
    this.wakeLock = null;
    this.startToken = 0;
    this.countdownTimer = null;
    this.tickTimer = null;
    this.meterFrame = 0;
    this.meterWin = null;
    this.peakHold = 0;
    this.vizHistory = [];
    this.installPrompt = null;
    this.warnedNoSystemAudio = false;
    this.els = this.collectElements();
    this.library = new AVR.Library($('#library'), {
      onPlay: this.openFromLibrary.bind(this),
      onDeleted: this.onRecordingDeleted.bind(this),
      onRenamed: this.onRecordingRenamed.bind(this),
    });
    this.prompter = new AVR.Teleprompter($('#prompter'), S.prompter, AVR.saveSettings);
    this.floating = new AVR.FloatingControls($('#floatPanel'));
    this.init();
  }

  App.prototype.collectElements = function () {
    var ids = [
      'envBanner', 'stage', 'previewVideo', 'canvasHost', 'audioViz', 'playbackVideo', 'stagePlaceholder',
      'placeholderIcon', 'placeholderText', 'previewBtn', 'placeholderNote', 'stageBusy', 'busyText', 'countdown',
      'countdownOverlay', 'stageFlash', 'recBadge', 'recBadgeLabel', 'recBadgeTime', 'stageChip', 'stageHint', 'meterRow', 'meterFill',
      'meterPeak', 'meterDb', 'meter', 'meterIcon', 'recSize', 'muteBtn', 'flipBtn', 'camToggleBtn', 'recordBtn',
      'pauseBtn', 'snapshotBtn', 'prompterBtn', 'popoutBtn', 'controlBar', 'reviewBar', 'reviewInfo', 'downloadBtn',
      'shareBtn', 'frameBtn', 'wavBtn', 'deleteBtn', 'newBtn', 'videoSource', 'audioSource', 'mirrorCamera',
      'systemAudio', 'systemAudioHint', 'permissionHint', 'resolution', 'fps', 'quality', 'aspect', 'videoFormat',
      'audioFormat', 'qualityHint', 'micGain', 'micGainValue', 'noiseSuppression', 'echoCancellation',
      'autoGainControl', 'prompterVisible', 'prompterScript', 'prompterSpeed', 'prompterSpeedValue', 'prompterSize',
      'prompterSizeValue', 'prompterAutoStart', 'prompterMirror', 'prompterSettings', 'countdownBeep',
      'floatingControls', 'floatingControlsField', 'helpBtn', 'helpDialog', 'installBtn', 'offlinePill', 'floatPanel',
      'floatTime', 'floatStatus', 'floatMeterFill', 'floatPrompterSlot', 'sourceHost',
    ];
    var els = {};
    ids.forEach(function (id) { els[id] = document.getElementById(id); });
    els.countdownSelect = document.getElementById('countdown');
    return els;
  };

  // ---------------------------------------------------------------- startup

  App.prototype.init = function () {
    var self = this;
    this.checkEnvironment();
    this.bindModeTabs();
    this.bindControls();
    this.bindSettings();
    this.bindGlobalEvents();
    this.populateFormats();

    var requested = new URLSearchParams(location.search).get('mode');
    if (requested && MODES[requested]) S.mode = requested;
    if (!P.canCaptureScreen && MODES[S.mode].screen) S.mode = 'camera';
    this.applyMode();
    this.prompter.show(!!S.prompter.visible);
    this.render();

    this.refreshDevices().then(function () { return self.maybeAutoPreview(); });

    AVR.RecordingSession.recoverAll().then(function (recovered) {
      if (recovered.length) {
        AVR.toast(
          (recovered.length === 1 ? 'An unfinished recording was' : recovered.length + ' unfinished recordings were') +
          ' recovered after the page closed unexpectedly. See Your recordings.',
          'warning',
          { timeout: 12000 }
        );
      }
    }).then(function () { return self.library.refresh(); });

    this.registerServiceWorker();
  };

  App.prototype.checkEnvironment = function () {
    var msg = '';
    if (!P.secure) msg = 'This page must be opened over https:// to use your camera, microphone or screen.';
    else if (!P.hasMedia) msg = 'This browser cannot use cameras or microphones. Please use a current version of Chrome, Edge, Firefox or Safari.';
    else if (!P.hasRecorder) msg = 'This browser cannot record. Please update it (on iPhone or iPad, iOS 14.3 or newer is needed).';
    this.blocked = !!msg;
    if (msg) {
      this.els.envBanner.innerHTML = AVR.icon('warning-circle-fill') + '<span></span>';
      this.els.envBanner.querySelector('span').textContent = msg;
      this.els.envBanner.hidden = false;
    }
  };

  App.prototype.registerServiceWorker = function () {
    if (!('serviceWorker' in navigator)) return;
    var local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (location.protocol !== 'https:' && !local) return;
    navigator.serviceWorker.register('sw.js').catch(function () { /* offline support is optional */ });
  };

  // Starts the preview without a click when that won't surprise anyone: the
  // mode needs no screen picker and the permissions were granted before.
  App.prototype.maybeAutoPreview = function () {
    var self = this;
    var mode = MODES[S.mode];
    if (this.blocked || mode.screen || this.state !== 'idle') return Promise.resolve();
    if (!navigator.permissions || !navigator.permissions.query) return Promise.resolve();
    var names = mode.cam ? ['camera'] : [];
    if (S.audioDeviceId !== 'none') names.push('microphone');
    return Promise.all(names.map(function (name) {
      return navigator.permissions.query({ name: name }).then(function (r) { return r.state; }, function () { return 'unknown'; });
    })).then(function (states) {
      var granted = states.every(function (s) { return s === 'granted'; });
      if (granted && self.state === 'idle' && !MODES[S.mode].screen) self.startPreview();
    });
  };

  // ---------------------------------------------------------------- bindings

  App.prototype.bindModeTabs = function () {
    var self = this;
    $$('.mode-tab').forEach(function (tab) {
      var mode = tab.getAttribute('data-mode');
      if (MODES[mode].screen && !P.canCaptureScreen) {
        // Phones can never do it, so don't offer it; the help explains why.
        // A desktop browser that can't gets a disabled tab that explains itself.
        if (P.isMobile) tab.hidden = true;
        tab.classList.add('unsupported');
        tab.setAttribute('aria-disabled', 'true');
        tab.title = 'This browser cannot record the screen';
      }
      tab.addEventListener('click', function () { self.selectMode(mode); });
    });
  };

  App.prototype.bindControls = function () {
    var self = this;
    var e = this.els;
    e.recordBtn.addEventListener('click', function () { self.onRecordPressed(); });
    e.previewBtn.addEventListener('click', function () {
      self.engine.resume();
      self.startPreview();
    });
    e.pauseBtn.addEventListener('click', function () { self.togglePause(); });
    e.muteBtn.addEventListener('click', function () { self.toggleMute(); });
    e.camToggleBtn.addEventListener('click', function () { self.toggleCamera(); });
    e.flipBtn.addEventListener('click', function () { self.flipCamera(); });
    e.snapshotBtn.addEventListener('click', function () { self.snapshot(); });
    e.prompterBtn.addEventListener('click', function () { self.setPrompterVisible(!S.prompter.visible); });
    e.popoutBtn.addEventListener('click', function () { self.toggleFloating(); });

    e.downloadBtn.addEventListener('click', function () { self.downloadReview(); });
    e.shareBtn.addEventListener('click', function () { self.shareReview(); });
    e.frameBtn.addEventListener('click', function () { self.saveReviewFrame(); });
    e.wavBtn.addEventListener('click', function () { self.reviewWav(); });
    e.deleteBtn.addEventListener('click', function () { self.deleteReview(); });
    e.newBtn.addEventListener('click', function () { self.newRecording(); });

    this.prompter.onEdit = function () {
      e.prompterSettings.open = true;
      e.prompterScript.focus();
      e.prompterSettings.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };
    this.prompter.onClose = function () { self.setPrompterVisible(false); };

    $('#floatPanel').addEventListener('click', function (ev) {
      var btn = ev.target.closest ? ev.target.closest('[data-float]') : null;
      if (!btn) return;
      var action = btn.getAttribute('data-float');
      if (action === 'mute') self.toggleMute();
      else if (action === 'camera') self.toggleCamera();
      else if (action === 'pause') self.togglePause();
      else if (action === 'record') self.onRecordPressed(true);
    });
    this.floating.onOpen = function (win) {
      win.document.addEventListener('keydown', function (ev) { self.onKey(ev); });
      if (S.prompter.visible) {
        e.floatPrompterSlot.appendChild($('#prompter'));
        self.prompter.rehost();
      }
      self.startMeterLoop();
      self.render();
    };
    this.floating.onClose = function () {
      var prompterEl = document.getElementById('prompter') || e.floatPrompterSlot.querySelector('#prompter');
      if (prompterEl && prompterEl.parentNode !== e.stage) {
        e.stage.appendChild(prompterEl);
        self.prompter.rehost();
      }
      self.render();
    };

    e.helpBtn.addEventListener('click', function () { self.openHelp(); });
    e.helpDialog.addEventListener('click', function (ev) {
      if (ev.target === e.helpDialog || (ev.target.closest && ev.target.closest('[data-close]'))) self.closeHelp();
    });

    e.installBtn.addEventListener('click', function () {
      if (!self.installPrompt) return;
      self.installPrompt.prompt();
      var choice = self.installPrompt.userChoice;
      self.installPrompt = null;
      e.installBtn.hidden = true;
      if (choice && choice.catch) choice.catch(function () {});
    });

    e.playbackVideo.addEventListener('error', function () {
      if (self.state === 'review') {
        AVR.toast('This browser cannot preview this file, but you can still download it.', 'warning');
      }
    });
  };

  App.prototype.bindSettings = function () {
    var self = this;
    var e = this.els;

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

    select(e.resolution, 'resolution', str, function () { self.onVideoSettingChanged(); });
    select(e.fps, 'fps', num, function () { self.onVideoSettingChanged(); });
    select(e.quality, 'quality', str, function () { self.updateQualityHint(); });
    select(e.aspect, 'aspect', str, function () { self.onVideoSettingChanged(); });
    select(e.countdownSelect, 'countdown', num);

    e.videoSource.addEventListener('change', function () {
      S.videoDeviceId = e.videoSource.value;
      AVR.saveSettings();
      self.restartSource('cam');
    });
    e.audioSource.addEventListener('change', function () {
      S.audioDeviceId = e.audioSource.value;
      AVR.saveSettings();
      self.restartSource('mic');
    });

    check(e.mirrorCamera, S, 'mirror', function () { self.applyMirror(); });
    check(e.systemAudio, S, 'systemAudio', function () {
      if (self.src.screen && self.state === 'preview') {
        AVR.toast('This applies the next time you choose what to share.', 'info');
      }
    });
    ['noiseSuppression', 'echoCancellation', 'autoGainControl'].forEach(function (key) {
      check(e[key], S, key, function () { self.restartSource('mic'); });
    });
    check(e.countdownBeep, S, 'countdownBeep');
    check(e.floatingControls, S, 'floatingControls');
    e.floatingControlsField.hidden = !AVR.FloatingControls.supported();

    e.micGain.value = Math.round(S.micGain * 100);
    e.micGainValue.textContent = e.micGain.value + '%';
    e.micGain.addEventListener('input', function () {
      S.micGain = Number(e.micGain.value) / 100;
      e.micGainValue.textContent = e.micGain.value + '%';
      if (self.mixer) self.mixer.setMicGain(S.micGain);
      AVR.saveSettings();
    });

    // Teleprompter
    var p = S.prompter;
    e.prompterScript.value = p.text;
    e.prompterScript.addEventListener('input', function () {
      p.text = e.prompterScript.value;
      self.prompter.setText(p.text);
      AVR.saveSettings();
    });
    check(e.prompterVisible, p, 'visible', function () { self.setPrompterVisible(p.visible); });
    check(e.prompterAutoStart, p, 'autoStart');
    check(e.prompterMirror, p, 'mirror', function () { self.prompter.applyStyle(); });
    e.prompterSpeed.value = p.speed;
    e.prompterSize.value = p.fontSize;
    function syncPrompterOutputs() {
      e.prompterSpeed.value = p.speed;
      e.prompterSize.value = p.fontSize;
      e.prompterSpeedValue.textContent = String(p.speed);
      e.prompterSizeValue.textContent = p.fontSize + 'px';
      e.prompterMirror.checked = !!p.mirror;
    }
    syncPrompterOutputs();
    e.prompterSpeed.addEventListener('input', function () { self.prompter.setSpeed(Number(e.prompterSpeed.value)); syncPrompterOutputs(); });
    e.prompterSize.addEventListener('input', function () { self.prompter.setFontSize(Number(e.prompterSize.value)); syncPrompterOutputs(); });
    // Keep the settings panel in step with the on-stage toolbar.
    var origApply = this.prompter.applyStyle.bind(this.prompter);
    this.prompter.applyStyle = function () { origApply(); syncPrompterOutputs(); };

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
        if (self.compositor) self.compositor.draw();
      });
      sync();
    });
    $$('.corner-picker button').forEach(function (b) {
      b.addEventListener('click', function () {
        var xy = b.getAttribute('data-corner').split(',');
        S.bubble.x = Number(xy[0]);
        S.bubble.y = Number(xy[1]);
        AVR.saveSettings();
        if (self.compositor) self.compositor.draw();
      });
    });

    this.updateSystemAudioHint();
  };

  App.prototype.populateFormats = function () {
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
      if (el.value !== S[key]) { el.value = 'auto'; S[key] = 'auto'; }
      el.addEventListener('change', function () {
        S[key] = el.value;
        AVR.saveSettings();
      });
    });
    this.updateQualityHint();
  };

  App.prototype.updateSystemAudioHint = function () {
    var el = this.els.systemAudioHint;
    if (P.isFirefox || P.isSafari) {
      el.textContent = 'This browser can record your microphone but not sound playing on the computer. Use Chrome or Edge for that.';
    } else {
      el.textContent = 'In the sharing dialog, tick "Share audio" (for a tab, or the whole screen on Windows).';
    }
  };

  App.prototype.updateQualityHint = function () {
    var size = this.outputSize() || { width: AVR.formats.presetSize(S.resolution).long, height: AVR.formats.presetSize(S.resolution).short };
    var bits = AVR.formats.videoBitrate(size.width, size.height, S.fps, S.quality) + AVR.formats.audioBitrate(S.quality);
    var perMinute = (bits / 8) * 60;
    this.els.qualityHint.textContent = 'About ' + AVR.formatBytes(perMinute) + ' per minute at most' +
      (this.outputSize() ? ' (' + size.width + '×' + size.height + ')' : '') + '. Simple screens and still shots use much less.';
  };

  App.prototype.bindGlobalEvents = function () {
    var self = this;
    document.addEventListener('keydown', function (ev) { self.onKey(ev); });

    // First interaction unlocks audio (autoplay policies).
    var unlock = function () {
      self.engine.resume();
      document.removeEventListener('pointerdown', unlock, true);
      document.removeEventListener('keydown', unlock, true);
    };
    document.addEventListener('pointerdown', unlock, true);
    document.addEventListener('keydown', unlock, true);

    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', function () { self.refreshDevices(); });
    }

    document.addEventListener('visibilitychange', function () { self.onVisibilityChange(); });

    window.addEventListener('beforeunload', function (ev) {
      if (LIVE_STATES[self.state]) {
        ev.preventDefault();
        ev.returnValue = '';
        return '';
      }
    });

    window.addEventListener('beforeinstallprompt', function (ev) {
      ev.preventDefault();
      self.installPrompt = ev;
      self.els.installBtn.hidden = false;
    });
    window.addEventListener('appinstalled', function () {
      self.els.installBtn.hidden = true;
      self.installPrompt = null;
    });

    function updateOnline() { self.els.offlinePill.hidden = navigator.onLine !== false; }
    window.addEventListener('online', updateOnline);
    window.addEventListener('offline', updateOnline);
    updateOnline();

    window.addEventListener('resize', function () { self.sizeViz(); });
  };

  App.prototype.onKey = function (ev) {
    if (ev.defaultPrevented || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    var t = ev.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    var helpOpen = this.els.helpDialog.open || this.els.helpDialog.classList.contains('fallback-open');
    if (helpOpen) {
      if (ev.key === 'Escape' && !this.els.helpDialog.showModal) this.closeHelp();
      return;
    }
    var key = ev.key;
    var lower = key.length === 1 ? key.toLowerCase() : key;
    var live = this.state === 'recording' || this.state === 'paused';

    if (lower === 'r') { this.onRecordPressed(); }
    else if (lower === 'p' || (key === ' ' && live && !(t && t.tagName === 'BUTTON'))) {
      if (live) { ev.preventDefault(); this.togglePause(); } else return;
    }
    else if (lower === 'm') { this.toggleMute(); }
    else if (lower === 'c') { this.toggleCamera(); }
    else if (lower === 's') { this.snapshot(); }
    else if (lower === 't') {
      if (!S.prompter.visible) this.setPrompterVisible(true);
      else this.prompter.toggle();
    }
    else if (key === '?') { this.openHelp(); }
    else if (key === 'Escape' && this.state === 'countdown') { this.cancelCountdown(); }
    else return;
    ev.preventDefault();
  };

  App.prototype.openHelp = function () {
    var d = this.els.helpDialog;
    if (d.open || d.classList.contains('fallback-open')) return;
    if (d.showModal) {
      d.showModal();
    } else {
      // Browsers without <dialog> (Safari before 15.4)
      d.classList.add('fallback-open');
      d.setAttribute('open', '');
    }
  };

  App.prototype.closeHelp = function () {
    var d = this.els.helpDialog;
    if (d.close) d.close();
    d.classList.remove('fallback-open');
    d.removeAttribute('open');
  };

  // ---------------------------------------------------------------- modes

  App.prototype.selectMode = function (mode) {
    if (!MODES[mode]) return;
    if (MODES[mode].screen && !P.canCaptureScreen) {
      AVR.toast(P.isMobile
        ? 'Phones and tablets do not allow screen recording in a browser. Use the built-in screen recorder (Control Center on iPhone, Quick Settings on Android).'
        : 'This browser cannot record the screen. Try Chrome, Edge or Firefox.', 'info', { timeout: 8000 });
      return;
    }
    if (mode === S.mode) return;
    if (LIVE_STATES[this.state]) {
      AVR.toast('Stop the current recording before switching.', 'info');
      return;
    }
    var prev = S.mode;
    S.mode = mode;
    AVR.saveSettings();
    if (this.state === 'review') this.clearReview();
    this.applyMode();

    var needs = MODES[mode];
    // A start still in progress (e.g. a permission prompt) counts as a preview;
    // startPreview() below supersedes it.
    var hadPreview = this.state === 'preview' || this.state === 'starting';
    if (this.state === 'starting') this.startToken++;
    // Keep what is still useful (switching Screen ⇄ Screen + Cam keeps the
    // shared screen) and release the rest, so the camera light goes off.
    if (!needs.screen) this.releaseSource('screen');
    if (!needs.cam) this.releaseSource('cam');
    if (hadPreview && (!needs.screen || this.src.screen)) {
      this.startPreview();
    } else {
      if (!this.src.screen) this.releaseAll();
      this.setState('idle');
      if (!(MODES[prev].screen && needs.screen)) this.maybeAutoPreview();
    }
  };

  App.prototype.applyMode = function () {
    var mode = S.mode;
    var m = MODES[mode];
    $$('.mode-tab').forEach(function (tab) {
      var on = tab.getAttribute('data-mode') === mode;
      tab.setAttribute('aria-selected', String(on));
      tab.classList.toggle('active', on);
    });
    $$('[data-modes]').forEach(function (el) {
      el.hidden = el.getAttribute('data-modes').split(' ').indexOf(mode) === -1;
    });
    this.els.placeholderIcon.setAttribute('href', '#i-' + m.icon);
    this.els.placeholderText.textContent = m.text;
    this.els.previewBtn.textContent = m.button;
    this.setPlaceholderNote('');
  };

  App.prototype.setPlaceholderNote = function (text, isError) {
    var el = this.els.placeholderNote;
    el.textContent = text || '';
    el.hidden = !text;
    el.classList.toggle('error', !!isError);
  };

  // ---------------------------------------------------------------- devices

  App.prototype.refreshDevices = function () {
    var self = this;
    var md = navigator.mediaDevices;
    if (!md || !md.enumerateDevices) return Promise.resolve();
    return md.enumerateDevices().then(function (devices) {
      var cams = devices.filter(function (d) { return d.kind === 'videoinput' && d.deviceId; });
      var mics = devices.filter(function (d) {
        return d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications';
      });
      var labelled = devices.some(function (d) { return !!d.label; });
      self.els.permissionHint.hidden = labelled || !devices.length;

      function fill(select, list, defaultLabel, prefix, extra) {
        var current = select.value;
        select.innerHTML = '';
        var def = document.createElement('option');
        def.value = '';
        def.textContent = defaultLabel;
        select.appendChild(def);
        list.forEach(function (d, i) {
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
        return current;
      }
      fill(self.els.videoSource, cams, P.isMobile ? 'Default (use Flip to switch)' : 'Default camera', 'Camera');
      fill(self.els.audioSource, mics, 'Default microphone', 'Microphone', [{ value: 'none', label: 'No microphone' }]);
      self.els.videoSource.value = S.videoDeviceId;
      if (self.els.videoSource.value !== S.videoDeviceId) self.els.videoSource.value = '';
      self.els.audioSource.value = S.audioDeviceId;
      if (self.els.audioSource.value !== S.audioDeviceId) self.els.audioSource.value = '';

      self.cameraCount = cams.length;
      self.render();
    }).catch(function () { /* labels are a nicety */ });
  };

  App.prototype.videoConstraints = function () {
    var size = AVR.formats.presetSize(S.resolution);
    var c = {
      width: { ideal: size.long },
      height: { ideal: size.short },
      frameRate: { ideal: S.fps },
    };
    if (S.videoDeviceId) c.deviceId = { exact: S.videoDeviceId };
    else if (P.isMobile) c.facingMode = { ideal: S.facingMode };
    return c;
  };

  App.prototype.audioConstraints = function () {
    var c = {
      echoCancellation: S.echoCancellation,
      noiseSuppression: S.noiseSuppression,
      autoGainControl: S.autoGainControl,
    };
    if (S.audioDeviceId && S.audioDeviceId !== 'none') c.deviceId = { exact: S.audioDeviceId };
    return c;
  };

  function gum(constraints) {
    return navigator.mediaDevices.getUserMedia(constraints);
  }

  // Retries with plainer constraints when a saved device has gone or the
  // camera cannot do the requested size.
  App.prototype.getCamera = function () {
    var self = this;
    return gum({ video: this.videoConstraints(), audio: false }).catch(function (err) {
      if (err && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError' || err.name === 'NotReadableError' || err.name === 'AbortError')) {
        var loose = P.isMobile ? { facingMode: S.facingMode } : true;
        return gum({ video: loose, audio: false }).then(function (s) {
          if (S.videoDeviceId) {
            S.videoDeviceId = '';
            AVR.saveSettings();
            self.els.videoSource.value = '';
          }
          return s;
        }, function () { throw err; });
      }
      throw err;
    });
  };

  App.prototype.getMic = function () {
    var self = this;
    return gum({ audio: this.audioConstraints(), video: false }).catch(function (err) {
      if (err && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError' || err.name === 'NotReadableError' || err.name === 'AbortError')) {
        return gum({ audio: true, video: false }).then(function (s) {
          if (S.audioDeviceId) {
            S.audioDeviceId = '';
            AVR.saveSettings();
            self.els.audioSource.value = '';
          }
          return s;
        }, function () { throw err; });
      }
      throw err;
    });
  };

  // One permission prompt for both, where possible.
  App.prototype.getCameraAndMic = function () {
    var self = this;
    return gum({ video: this.videoConstraints(), audio: this.audioConstraints() }).then(function (s) {
      return {
        cam: new MediaStream(s.getVideoTracks()),
        mic: s.getAudioTracks().length ? new MediaStream(s.getAudioTracks()) : null,
      };
    }, function () {
      // Find out which one failed, and keep the one that works.
      return self.getCamera().then(function (cam) {
        return self.getMic().then(function (mic) {
          return { cam: cam, mic: mic };
        }, function (micErr) {
          return { cam: cam, mic: null, micError: micErr };
        });
      });
    });
  };

  App.prototype.getScreen = function () {
    var size = AVR.formats.presetSize(S.resolution);
    var opts = {
      video: {
        width: { max: size.long },
        height: { max: size.long },
        frameRate: { ideal: S.fps, max: S.fps },
      },
      audio: S.systemAudio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      systemAudio: S.systemAudio ? 'include' : 'exclude',
      monitorTypeSurfaces: 'include',
    };
    var md = navigator.mediaDevices;
    return md.getDisplayMedia(opts).catch(function (err) {
      // Older browsers reject options they don't know. Never retry after the
      // person cancelled, or the picker would pop up again.
      if (err && (err.name === 'TypeError' || err.name === 'OverconstrainedError' || err.name === 'NotSupportedError')) {
        return md.getDisplayMedia({ video: true, audio: !!S.systemAudio });
      }
      throw err;
    });
  };

  // ---------------------------------------------------------------- sources

  App.prototype.setSource = function (kind, stream) {
    var self = this;
    this.releaseSource(kind);
    this.src[kind] = stream;
    if (!stream) return;
    stream.getTracks().forEach(function (track) {
      track.addEventListener('ended', function () {
        if (self.src[kind] === stream) self.onSourceEnded(kind, track);
      });
      track.addEventListener('mute', function () { if (self.src[kind] === stream) self.onTrackMute(kind, track, true); });
      track.addEventListener('unmute', function () { if (self.src[kind] === stream) self.onTrackMute(kind, track, false); });
    });
    if (kind === 'mic') {
      var mic = firstTrack(stream, 'audio');
      if (mic) mic.enabled = !this.muted;
    }
  };

  App.prototype.releaseSource = function (kind) {
    var stream = this.src[kind];
    this.src[kind] = null;
    stopStream(stream);
    var v = this.srcVideos[kind];
    if (v) {
      v.srcObject = null;
      v.remove();
      this.srcVideos[kind] = null;
    }
  };

  App.prototype.releaseAll = function () {
    this.teardownPipeline();
    this.releaseSource('screen');
    this.releaseSource('cam');
    this.releaseSource('mic');
  };

  App.prototype.hasLiveSources = function () {
    var m = MODES[S.mode];
    var live = function (s) {
      return !!s && s.getTracks().some(function (t) { return t.readyState === 'live'; });
    };
    if (m.screen) return live(this.src.screen);
    if (m.cam) return live(this.src.cam);
    return live(this.src.mic);
  };

  App.prototype.startPreview = function () {
    var self = this;
    if (this.blocked || LIVE_STATES[this.state]) return Promise.resolve(false);
    var mode = S.mode;
    var need = MODES[mode];
    var wantMic = S.audioDeviceId !== 'none';
    var token = ++this.startToken;
    var stale = function () { return token !== self.startToken; };
    if (this.state === 'review') this.clearReview();
    this.teardownPipeline();
    this.setState('starting');
    this.setPlaceholderNote('');

    if (!need.screen) this.releaseSource('screen');
    if (!need.cam) this.releaseSource('cam');
    if (!wantMic) this.releaseSource('mic');

    var warnings = [];
    var chain = Promise.resolve();

    // Ask for the screen first, while the click still counts as a user gesture.
    if (need.screen && !this.src.screen) {
      chain = chain.then(function () {
        return self.getScreen().then(function (s) {
          if (stale()) { stopStream(s); return; }
          self.setSource('screen', s);
          self.checkSystemAudio(s);
        }, function (err) {
          err.what = 'screen';
          throw err;
        });
      });
    }

    chain = chain.then(function () {
      if (stale()) return;
      var needCam = need.cam && !self.src.cam;
      var needMic = wantMic && !self.src.mic;
      if (needCam && needMic) {
        return self.getCameraAndMic().then(function (r) {
          if (stale()) { stopStream(r.cam); stopStream(r.mic); return; }
          self.setSource('cam', r.cam);
          self.setSource('mic', r.mic);
          if (r.micError) warnings.push('Recording without a microphone. ' + AVR.describeMediaError(r.micError, 'microphone'));
        }, function (err) {
          if (mode === 'screencam') {
            warnings.push('Camera unavailable, so this will record the screen only. ' + AVR.describeMediaError(err, 'camera'));
            return self.getMic().then(function (mic) {
              if (stale()) { stopStream(mic); return; }
              self.setSource('mic', mic);
            }, function () {});
          }
          err.what = 'camera';
          throw err;
        });
      }
      if (needCam) {
        return self.getCamera().then(function (cam) {
          if (stale()) { stopStream(cam); return; }
          self.setSource('cam', cam);
        }, function (err) {
          if (mode === 'screencam') {
            warnings.push('Camera unavailable, so this will record the screen only. ' + AVR.describeMediaError(err, 'camera'));
            return;
          }
          err.what = 'camera';
          throw err;
        });
      }
      if (needMic) {
        return self.getMic().then(function (mic) {
          if (stale()) { stopStream(mic); return; }
          self.setSource('mic', mic);
        }, function (err) {
          if (mode === 'audio') { err.what = 'microphone'; throw err; }
          warnings.push('Recording without a microphone. ' + AVR.describeMediaError(err, 'microphone'));
        });
      }
    });

    return chain.then(function () {
      if (stale()) return false;
      if (!self.hasLiveSources()) throw new Error('The source stopped before the preview could start.');
      return self.buildPipeline().then(function () {
        if (stale()) return false;
        self.setState('preview');
        warnings.forEach(function (w) { AVR.toast(w, 'warning', { timeout: 9000 }); });
        self.refreshDevices();
        return true;
      });
    }).catch(function (err) {
      if (stale()) return false;
      var what = err && err.what;
      var cancelled = what === 'screen' && err && (err.name === 'NotAllowedError' || err.name === 'AbortError') && !/system/i.test(err.message || '');
      self.releaseAll();
      self.setState('idle');
      var msg = what ? AVR.describeMediaError(err, what) : (err && err.message) || 'Could not start the preview.';
      self.setPlaceholderNote(cancelled ? '' : msg, !cancelled);
      if (!cancelled) AVR.toast(msg, 'error');
      return false;
    });
  };

  App.prototype.checkSystemAudio = function (screenStream) {
    if (!S.systemAudio || this.warnedNoSystemAudio) return;
    if (screenStream.getAudioTracks().length) return;
    this.warnedNoSystemAudio = true;
    var msg = (P.isFirefox || P.isSafari)
      ? 'This browser records your microphone but not sound playing on the computer.'
      : 'No computer sound was shared. To include it next time, tick "Share audio" in the sharing dialog.';
    AVR.toast(msg, 'info', { timeout: 8000 });
  };

  // Re-opens one source after a device or setting change, without asking to
  // share the screen again.
  App.prototype.restartSource = function (kind) {
    var self = this;
    if (this.state !== 'preview') return;
    if (kind === 'cam' && !MODES[S.mode].cam) return;
    var token = ++this.startToken;
    var getter = kind === 'cam' ? this.getCamera() : (S.audioDeviceId === 'none' ? Promise.resolve(null) : this.getMic());
    this.releaseSource(kind);
    this.teardownPipeline();
    this.setState('starting');
    return getter.then(function (stream) {
      if (token !== self.startToken) { stopStream(stream); return; }
      self.setSource(kind, stream);
      return self.buildPipeline().then(function () {
        self.setState('preview');
        self.refreshDevices();
      });
    }).catch(function (err) {
      if (token !== self.startToken) return;
      AVR.toast(AVR.describeMediaError(err, kind === 'cam' ? 'camera' : 'microphone'), 'error');
      if (self.hasLiveSources()) {
        self.buildPipeline().then(function () { self.setState('preview'); });
      } else {
        self.releaseAll();
        self.setState('idle');
      }
    });
  };

  App.prototype.onVideoSettingChanged = function () {
    this.updateQualityHint();
    if (this.state !== 'preview') return;
    var screenTrack = firstTrack(this.src.screen, 'video');
    if (screenTrack && screenTrack.applyConstraints) {
      var size = AVR.formats.presetSize(S.resolution);
      screenTrack.applyConstraints({
        width: { max: size.long }, height: { max: size.long }, frameRate: { ideal: S.fps, max: S.fps },
      }).catch(function () {});
    }
    if (MODES[S.mode].cam) this.restartSource('cam');
    else if (this.src.screen) {
      var self = this;
      setTimeout(function () {
        if (self.state === 'preview') { self.teardownPipeline(); self.buildPipeline(); }
      }, 300);
    }
  };

  App.prototype.flipCamera = function () {
    if (this.state !== 'preview' && this.state !== 'idle') return;
    S.facingMode = S.facingMode === 'user' ? 'environment' : 'user';
    S.videoDeviceId = '';
    this.els.videoSource.value = '';
    S.mirror = S.facingMode === 'user';
    this.els.mirrorCamera.checked = S.mirror;
    AVR.saveSettings();
    if (this.state === 'preview') this.restartSource('cam');
  };

  App.prototype.onSourceEnded = function (kind) {
    var live = this.state === 'recording' || this.state === 'paused';
    var mode = S.mode;
    if (live) {
      if (kind === 'screen') {
        AVR.toast('Screen sharing ended, so the recording was stopped and saved.', 'info');
        this.stopRecording();
      } else if (kind === 'cam') {
        if (mode === 'camera') {
          AVR.toast('The camera disconnected. The recording so far was saved.', 'warning');
          this.stopRecording();
        } else {
          AVR.toast('The camera disconnected. Recording continues with the screen only.', 'warning');
          if (this.compositor) this.compositor.showCamera = false;
        }
      } else if (kind === 'mic') {
        if (mode === 'audio') {
          AVR.toast('The microphone disconnected. The recording so far was saved.', 'warning');
          this.stopRecording();
        } else {
          AVR.toast('The microphone disconnected. Recording continues without sound from it.', 'warning');
        }
      }
      return;
    }
    if (this.state === 'preview' || this.state === 'countdown') {
      if (this.state === 'countdown') this.cancelCountdown();
      this.releaseSource(kind);
      var required = (kind === 'screen' && MODES[mode].screen) || (kind === 'cam' && mode === 'camera') || (kind === 'mic' && mode === 'audio');
      if (required) {
        this.releaseAll();
        this.setState('idle');
        if (kind !== 'screen') this.setPlaceholderNote(kind === 'cam' ? 'The camera disconnected.' : 'The microphone disconnected.', true);
      } else {
        this.teardownPipeline();
        var self = this;
        this.buildPipeline().then(function () { self.render(); });
      }
    }
  };

  // iPhones and Android phones cut off the camera and microphone when the app
  // goes to the background or a call comes in. Pause instead of recording a
  // frozen picture, and carry on when they come back.
  App.prototype.onTrackMute = function (kind, track, muted) {
    var mode = S.mode;
    var relevant = (mode === 'camera' && kind === 'cam') || (mode === 'audio' && kind === 'mic');
    if (!relevant) return;
    if (muted && this.state === 'recording') {
      if (this.pause(true)) AVR.toast('Recording paused: the ' + (kind === 'cam' ? 'camera' : 'microphone') + ' was interrupted. It resumes when it comes back.', 'warning');
    } else if (!muted && this.state === 'paused' && this.autoPaused) {
      if (this.resume()) AVR.toast('Recording resumed.', 'success');
    }
  };

  App.prototype.onVisibilityChange = function () {
    var visible = document.visibilityState === 'visible';
    if (visible) {
      if (LIVE_STATES[this.state] || this.state === 'preview') this.acquireWakeLock();
      if (this.state === 'paused' && this.autoPaused) {
        var cam = firstTrack(this.src.cam, 'video');
        if (!cam || !cam.muted) {
          if (this.resume()) AVR.toast('Recording resumed.', 'success');
        }
      }
    } else if (P.isMobile && this.state === 'recording' && S.mode === 'camera') {
      if (this.pause(true)) AVR.toast('Recording paused while the app was in the background.', 'warning');
    }
    // Animation frames stop in a hidden tab; move the meter to the floating
    // window (if open) or restart it on return.
    this.startMeterLoop();
  };

  // ---------------------------------------------------------------- pipeline

  App.prototype.sourceVideo = function (kind) {
    if (this.srcVideos[kind]) return this.srcVideos[kind];
    var v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    // Started with play(), not autoplay: Chrome pauses muted autoplay videos
    // that are off screen, and these are deliberately tiny and hidden.
    v.srcObject = new MediaStream(this.src[kind].getVideoTracks());
    this.els.sourceHost.appendChild(v);
    AVR.playSafely(v);
    this.srcVideos[kind] = v;
    return v;
  };

  App.prototype.buildPipeline = function () {
    var self = this;
    var e = this.els;
    var mode = S.mode;
    this.teardownPipeline();
    var size = AVR.formats.presetSize(S.resolution);
    var waitFor = Promise.resolve();

    if (mode === 'camera' && this.src.cam) {
      var camTrack = firstTrack(this.src.cam, 'video');
      var target = aspectValue(S.aspect);
      var st = camTrack && camTrack.getSettings ? camTrack.getSettings() : {};
      var actual = st.width && st.height ? st.width / st.height : 0;
      if (target && (!actual || Math.abs(actual - target) / target > 0.02)) {
        var camVideo = this.sourceVideo('cam');
        waitFor = AVR.waitForVideo(camVideo).then(function () {
          var crop = AVR.Compositor.cropSize(camVideo.videoWidth || 1280, camVideo.videoHeight || 720, target, size.long);
          self.makeCompositor({ width: crop.width, height: crop.height, layout: 'fill', main: camVideo });
        });
      } else {
        e.previewVideo.srcObject = this.src.cam;
        e.previewVideo.hidden = false;
        AVR.playSafely(e.previewVideo);
        waitFor = AVR.waitForVideo(e.previewVideo);
      }
    } else if (mode === 'screencam' && this.src.screen && this.src.cam) {
      var screenVideo = this.sourceVideo('screen');
      var camVid = this.sourceVideo('cam');
      waitFor = Promise.all([AVR.waitForVideo(screenVideo), AVR.waitForVideo(camVid, 3000)]).then(function () {
        var fit = AVR.Compositor.fitSize(screenVideo.videoWidth || 1920, screenVideo.videoHeight || 1080, size.long);
        self.makeCompositor({ width: fit.width, height: fit.height, layout: 'bubble', main: screenVideo, camera: camVid });
      });
    } else if (MODES[mode].screen && this.src.screen) {
      e.previewVideo.srcObject = new MediaStream(this.src.screen.getVideoTracks());
      e.previewVideo.hidden = false;
      AVR.playSafely(e.previewVideo);
      waitFor = AVR.waitForVideo(e.previewVideo);
    } else if (mode === 'audio') {
      e.audioViz.hidden = false;
      this.vizHistory = [];
      this.sizeViz();
    }

    var meterTrack = firstTrack(this.src.mic, 'audio') || firstTrack(this.src.screen, 'audio');
    this.meter = this.engine.meter(meterTrack);
    this.els.meterIcon.setAttribute('href', this.src.mic ? '#i-microphone' : '#i-speaker-high');
    this.startMeterLoop();

    if (mode === 'camera' || mode === 'audio') this.acquireWakeLock();

    return waitFor.then(function () {
      self.applyMirror();
      self.updateStageAspect();
      self.updateQualityHint();
    });
  };

  App.prototype.makeCompositor = function (opts) {
    var c = new AVR.Compositor({
      width: opts.width,
      height: opts.height,
      fps: S.fps,
      layout: opts.layout,
      main: opts.main,
      camera: opts.camera,
      bubble: S.bubble,
      mirror: S.mirror,
    });
    c.showCamera = !this.cameraHidden;
    c.onBubbleMoved = function () { AVR.saveSettings(); };
    this.els.canvasHost.innerHTML = '';
    this.els.canvasHost.appendChild(c.canvas);
    this.els.canvasHost.hidden = false;
    c.start();
    this.compositor = c;
    return c;
  };

  App.prototype.teardownPipeline = function () {
    var e = this.els;
    if (this.compositor) {
      this.compositor.stop();
      this.compositor = null;
    }
    e.canvasHost.innerHTML = '';
    e.canvasHost.hidden = true;
    e.previewVideo.srcObject = null;
    e.previewVideo.hidden = true;
    e.audioViz.hidden = true;
    if (this.meter) {
      this.meter.dispose();
      this.meter = null;
    }
    this.stopMeterLoop();
    this.resetMeter();
    // Source <video> elements that no longer feed anything can go.
    var m = MODES[S.mode];
    if (this.srcVideos.screen && !m.screen) this.releaseVideoEl('screen');
    if (this.srcVideos.cam && !(m.cam && (S.mode === 'screencam' || S.aspect !== 'auto'))) this.releaseVideoEl('cam');
  };

  App.prototype.releaseVideoEl = function (kind) {
    var v = this.srcVideos[kind];
    if (!v) return;
    v.srcObject = null;
    v.remove();
    this.srcVideos[kind] = null;
  };

  App.prototype.applyMirror = function () {
    var mirror = S.mirror && S.mode === 'camera';
    this.els.previewVideo.classList.toggle('mirrored', mirror && !this.compositor);
    this.els.canvasHost.classList.toggle('mirrored', mirror && !!this.compositor);
    if (this.compositor && this.compositor.layout === 'bubble') {
      this.compositor.mirror = S.mirror;
      this.compositor.draw();
    }
  };

  // The frame size that will be recorded, or null for audio / no source.
  App.prototype.outputSize = function () {
    if (this.compositor) return { width: this.compositor.canvas.width, height: this.compositor.canvas.height };
    var v = this.els.previewVideo;
    if (!v.hidden && v.videoWidth) return { width: v.videoWidth, height: v.videoHeight };
    return null;
  };

  App.prototype.updateStageAspect = function () {
    var size = this.outputSize();
    var ratio = size ? size.width / size.height : 16 / 9;
    if (this.state === 'review') {
      var pv = this.els.playbackVideo;
      ratio = pv.videoWidth ? pv.videoWidth / pv.videoHeight : 16 / 9;
    }
    ratio = Math.min(2.4, Math.max(0.5, ratio || 16 / 9));
    this.els.stage.style.setProperty('--stage-ar', ratio.toFixed(4));
    var chip = this.els.stageChip;
    if (size && (this.state === 'preview' || this.state === 'recording' || this.state === 'paused')) {
      chip.textContent = size.width + '×' + size.height + ' · ' + S.fps + ' fps';
      chip.hidden = false;
    } else {
      chip.hidden = true;
    }
  };

  // ---------------------------------------------------------------- meter

  App.prototype.startMeterLoop = function () {
    var self = this;
    this.stopMeterLoop();
    if (!this.meter) return;
    var step = function () {
      self.meterFrame = 0;
      self.drawMeter();
      var win = window;
      if (document.visibilityState !== 'visible' && self.floating.isOpen()) win = self.floating.win;
      if (document.visibilityState !== 'visible' && win === window) return;
      self.meterWin = win;
      self.meterFrame = win.requestAnimationFrame(step);
    };
    step();
  };

  App.prototype.stopMeterLoop = function () {
    if (this.meterFrame && this.meterWin) {
      try { this.meterWin.cancelAnimationFrame(this.meterFrame); } catch (e) { /* closed */ }
    }
    this.meterFrame = 0;
  };

  App.prototype.resetMeter = function () {
    this.els.meterFill.style.transform = 'scaleX(0)';
    this.els.meterPeak.style.left = '0%';
    this.els.meterDb.textContent = '–∞ dB';
    this.els.floatMeterFill.style.transform = 'scaleX(0)';
    this.peakHold = 0;
  };

  App.prototype.drawMeter = function () {
    if (!this.meter) return;
    var level = this.meter.read();
    var gain = this.src.mic ? S.micGain : 1;
    var muted = this.muted && this.src.mic;
    var peak = muted ? 0 : Math.min(1, level.peak * gain);
    // Below -60 dBFS is silence for our purposes.
    var db = peak > 0.001 ? 20 * Math.log(peak) / Math.LN10 : -Infinity;
    var pos = db === -Infinity ? 0 : Math.max(0, Math.min(1, (db + 60) / 60));
    this.peakHold = Math.max(pos, this.peakHold - 0.006);
    var e = this.els;
    var scale = 'scaleX(' + pos.toFixed(3) + ')';
    e.meterFill.style.transform = scale;
    e.floatMeterFill.style.transform = scale;
    e.meterPeak.style.left = (this.peakHold * 100).toFixed(1) + '%';
    var cls = db > -1 ? 'clip' : db > -9 ? 'hot' : '';
    e.meter.className = 'meter ' + cls;
    e.meterDb.textContent = muted ? 'Muted' : db === -Infinity ? '–∞ dB' : Math.round(db) + ' dB';
    e.meter.setAttribute('aria-valuenow', db === -Infinity ? '-60' : String(Math.round(Math.max(-60, db))));
    if (!e.audioViz.hidden) this.drawViz(pos, cls);
  };

  App.prototype.sizeViz = function () {
    var c = this.els.audioViz;
    if (c.hidden) return;
    var ratio = Math.min(2, window.devicePixelRatio || 1);
    var rect = c.getBoundingClientRect();
    c.width = Math.max(1, Math.round(rect.width * ratio));
    c.height = Math.max(1, Math.round(rect.height * ratio));
  };

  // A scrolling level history: easy to read at a glance, and it makes gaps
  // and clipping obvious.
  App.prototype.drawViz = function (pos, cls) {
    var c = this.els.audioViz;
    var ctx = c.getContext('2d');
    var W = c.width;
    var H = c.height;
    if (!W || !H) return;
    var bar = Math.max(3, Math.round(W / 140));
    var gap = Math.max(1, Math.round(bar / 2));
    var max = Math.ceil(W / (bar + gap));
    this.vizHistory.push({ v: pos, cls: cls });
    if (this.vizHistory.length > max) this.vizHistory.splice(0, this.vizHistory.length - max);
    ctx.clearRect(0, 0, W, H);
    var mid = H / 2;
    var live = this.state === 'recording';
    for (var i = 0; i < this.vizHistory.length; i++) {
      var item = this.vizHistory[this.vizHistory.length - 1 - i];
      var x = W - (i + 1) * (bar + gap);
      var h = Math.max(2, item.v * item.v * H * 0.9);
      ctx.fillStyle = item.cls === 'clip' ? '#ef4444' : item.cls === 'hot' ? '#f59e0b' : live ? '#f87171' : '#60a5fa';
      ctx.globalAlpha = 0.35 + 0.65 * (1 - i / max);
      ctx.fillRect(x, mid - h / 2, bar, h);
    }
    ctx.globalAlpha = 1;
  };

  // ---------------------------------------------------------------- record

  App.prototype.onRecordPressed = function (fromFloating) {
    if (this.blocked) return;
    this.engine.resume();
    var self = this;
    switch (this.state) {
      case 'idle':
        this.startPreview().then(function (ok) { if (ok) self.beginCountdown(); });
        break;
      case 'preview':
        if (!fromFloating) this.maybeOpenFloating();
        this.beginCountdown();
        break;
      case 'countdown':
        this.cancelCountdown();
        break;
      case 'recording':
      case 'paused':
        this.stopRecording();
        break;
      case 'review':
        this.newRecording();
        break;
    }
  };

  App.prototype.maybeOpenFloating = function () {
    if (!S.floatingControls || !MODES[S.mode].screen || !AVR.FloatingControls.supported() || this.floating.isOpen()) return;
    this.floating.open({ tall: S.prompter.visible }).catch(function () { /* optional */ });
  };

  App.prototype.toggleFloating = function () {
    if (this.floating.isOpen()) {
      this.floating.close();
      return;
    }
    this.floating.open({ tall: S.prompter.visible }).catch(function (err) {
      AVR.toast('Could not open floating controls: ' + (err && err.message ? err.message : 'blocked by the browser'), 'warning');
    });
  };

  App.prototype.beep = function (freq, ms) {
    if (!S.countdownBeep) return;
    var ctx = this.engine.resume();
    if (!ctx) return;
    try {
      var o = ctx.createOscillator();
      var g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + ms / 1000);
      o.connect(g);
      g.connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + ms / 1000 + 0.02);
    } catch (e) { /* a beep is not worth an error */ }
  };

  App.prototype.beginCountdown = function () {
    var self = this;
    if (!this.hasLiveSources()) {
      AVR.toast('The source is no longer available. Start the preview again.', 'error');
      this.releaseAll();
      this.setState('idle');
      return;
    }
    var n = Number(S.countdown) || 0;
    if (!n) {
      this.startRecording();
      return;
    }
    this.setState('countdown');
    var el = this.els.countdownOverlay;
    var tick = function () {
      if (self.state !== 'countdown') return;
      if (n <= 0) {
        el.hidden = true;
        self.startRecording();
        return;
      }
      el.textContent = String(n);
      el.hidden = false;
      el.classList.remove('pop');
      void el.offsetWidth;
      el.classList.add('pop');
      document.title = n + '… ' + BASE_TITLE;
      if (self.floating.isOpen()) self.els.floatTime.textContent = 'Starting in ' + n;
      self.beep(n === 1 ? 880 : 660, 90);
      n -= 1;
      self.countdownTimer = setTimeout(tick, 1000);
    };
    tick();
  };

  App.prototype.cancelCountdown = function () {
    clearTimeout(this.countdownTimer);
    this.els.countdownOverlay.hidden = true;
    document.title = BASE_TITLE;
    if (this.state === 'countdown') this.setState('preview');
  };

  App.prototype.buildOutputStream = function () {
    var tracks = [];
    var mode = S.mode;
    if (mode !== 'audio') {
      var video = null;
      if (this.compositor) video = firstTrack(this.compositor.captureStream(), 'video');
      else if (mode === 'camera') video = firstTrack(this.src.cam, 'video');
      else video = firstTrack(this.src.screen, 'video');
      if (video) tracks.push(video);
    }
    var mic = firstTrack(this.src.mic, 'audio');
    var sys = firstTrack(this.src.screen, 'audio');
    var audio = null;
    // Mix only when needed: two sources, or a volume change. A plain
    // microphone track is the most reliable thing to hand the recorder.
    if ((mic && sys) || (mic && Math.abs(S.micGain - 1) > 0.01)) {
      this.mixer = this.engine.mixer({ mic: mic, system: sys, micGain: S.micGain });
      if (this.mixer) audio = this.mixer.track;
      else if (sys && mic) AVR.toast('Could not mix computer sound with your microphone; recording the microphone only.', 'warning');
    }
    if (!audio) audio = mic || sys;
    if (audio) tracks.push(audio);
    return new MediaStream(tracks);
  };

  App.prototype.startRecording = function () {
    var self = this;
    var mode = S.mode;
    var kind = mode === 'audio' ? 'audio' : 'video';
    var stream;
    try {
      stream = this.buildOutputStream();
    } catch (err) {
      AVR.toast('Could not prepare the recording: ' + err.message, 'error');
      this.setState('preview');
      return;
    }
    if (!stream.getTracks().length) {
      AVR.toast('There is nothing to record. Check your devices and try again.', 'error');
      this.setState('preview');
      return;
    }
    var size = this.outputSize() || { width: 0, height: 0 };
    var format = AVR.formats.pick(kind, kind === 'audio' ? S.audioFormat : S.videoFormat);
    var session = new AVR.RecordingSession({
      stream: stream,
      kind: kind,
      mode: mode,
      format: format,
      videoBitsPerSecond: kind === 'video' ? AVR.formats.videoBitrate(size.width, size.height, S.fps, S.quality) : 0,
      audioBitsPerSecond: stream.getAudioTracks().length ? AVR.formats.audioBitrate(S.quality) : 0,
      width: size.width,
      height: size.height,
      name: MODES[mode].label + ' ' + AVR.stamp(),
    });
    session.onerror = function (err) {
      if (self.session !== session) return;
      AVR.toast('The recorder hit a problem (' + ((err && (err.name || err.message)) || 'unknown') + '). What was recorded so far has been saved.', 'error', { timeout: 10000 });
      self.stopRecording();
    };
    session.onwarning = function (msg) { AVR.toast(msg, 'warning', { timeout: 12000 }); };
    this.session = session;
    this.autoPaused = false;
    this.setState('recording');

    session.start().then(function () {
      if (self.session !== session) return;
      AVR.store.persist();
      self.acquireWakeLock();
      self.startTicker();
      if (S.prompter.visible && S.prompter.autoStart) {
        self.prompter.reset();
        self.prompter.play();
      }
      setTimeout(function () { self.captureThumbnail(session); }, 1200);
      self.render();
    }).catch(function (err) {
      if (self.session !== session) return;
      self.session = null;
      self.disposeMixer();
      self.setState('preview');
      AVR.toast('Could not start recording: ' + ((err && err.message) || 'this browser refused'), 'error', { timeout: 10000 });
    });
  };

  App.prototype.captureThumbnail = function (session) {
    if (this.session !== session || S.mode === 'audio') return;
    var source = this.compositor ? this.compositor.canvas : this.els.previewVideo;
    var w = source.videoWidth || source.width;
    var h = source.videoHeight || source.height;
    if (!w || !h) return;
    try {
      var c = document.createElement('canvas');
      c.width = 320;
      c.height = Math.max(1, Math.round((320 * h) / w));
      c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
      c.toBlob(function (blob) { session.setThumbnail(blob); }, 'image/jpeg', 0.75);
    } catch (e) { /* thumbnails are cosmetic */ }
  };

  App.prototype.pause = function (auto) {
    if (this.state !== 'recording' || !this.session) return false;
    // Pressed in the few milliseconds before the recorder has started.
    if (this.session.state !== 'recording') return false;
    if (!this.session.pause()) {
      if (!auto) AVR.toast('This browser cannot pause recordings.', 'warning');
      return false;
    }
    this.autoPaused = !!auto;
    this.prompter.pause();
    this.setState('paused');
    return true;
  };

  App.prototype.resume = function () {
    if (this.state !== 'paused' || !this.session) return false;
    if (!this.session.resume()) return false;
    this.autoPaused = false;
    if (S.prompter.visible && S.prompter.autoStart) this.prompter.play();
    this.setState('recording');
    return true;
  };

  App.prototype.togglePause = function () {
    if (this.state === 'recording') this.pause(false);
    else if (this.state === 'paused') this.resume();
  };

  App.prototype.toggleMute = function () {
    if (!this.src.mic) {
      if (S.mode !== 'screen' && S.mode !== 'screencam') AVR.toast('No microphone is active.', 'info');
      return;
    }
    this.muted = !this.muted;
    var mic = firstTrack(this.src.mic, 'audio');
    if (mic) mic.enabled = !this.muted;
    this.render();
    AVR.toast(this.muted ? 'Microphone muted' : 'Microphone on', this.muted ? 'warning' : 'success', { timeout: 1800 });
  };

  App.prototype.toggleCamera = function () {
    if (!this.compositor || this.compositor.layout !== 'bubble') return;
    this.cameraHidden = !this.cameraHidden;
    this.compositor.showCamera = !this.cameraHidden;
    this.compositor.draw();
    this.render();
  };

  App.prototype.stopRecording = function () {
    var self = this;
    var session = this.session;
    if (!session || this.state === 'saving') return;
    this.prompter.pause();
    this.stopTicker();
    this.setState('saving');
    session.stop().then(function (result) {
      self.session = null;
      self.disposeMixer();
      self.releaseAll();
      self.releaseWakeLock();
      self.floating.close();
      self.showReview(result, result.blob);
      self.library.refresh();
      if (result.saved) {
        AVR.toast('Saved (' + AVR.formatDuration(result.durationMs) + '). It is also in Your recordings below.', 'success');
      } else {
        AVR.toast('Recording ready, but it could not be saved in this browser. Download it now so you don\'t lose it.', 'warning', { timeout: 15000 });
      }
    }).catch(function (err) {
      self.session = null;
      self.disposeMixer();
      self.releaseAll();
      self.releaseWakeLock();
      self.floating.close();
      self.setState('idle');
      self.library.refresh();
      AVR.toast('Recording failed: ' + ((err && err.message) || 'unknown error'), 'error', { timeout: 12000 });
    });
  };

  App.prototype.disposeMixer = function () {
    if (this.mixer) {
      this.mixer.dispose();
      this.mixer = null;
    }
  };

  App.prototype.startTicker = function () {
    var self = this;
    this.stopTicker();
    this.tickTimer = setInterval(function () { self.updateTimer(); }, 250);
    this.updateTimer();
  };

  App.prototype.stopTicker = function () {
    clearInterval(this.tickTimer);
    this.tickTimer = null;
  };

  App.prototype.updateTimer = function () {
    var s = this.session;
    if (!s) return;
    var t = AVR.formatDuration(s.elapsed());
    var paused = this.state === 'paused';
    this.els.recBadgeTime.textContent = t;
    this.els.floatTime.textContent = t;
    this.els.recSize.textContent = AVR.formatBytes(s.bytes);
    document.title = (paused ? '❚❚ ' : '● ') + t + ' · ' + (paused ? 'Paused' : 'Recording') + ' | ' + BASE_TITLE;
  };

  // ---------------------------------------------------------------- snapshots

  App.prototype.snapshot = function () {
    var self = this;
    if (S.mode === 'audio' && this.state !== 'review') return;
    if (this.state === 'review') { this.saveReviewFrame(); return; }
    if (!(this.state === 'preview' || this.state === 'recording' || this.state === 'paused' || this.state === 'countdown')) return;
    var blobPromise;
    if (this.compositor) {
      blobPromise = this.compositor.snapshot('image/png');
    } else {
      blobPromise = this.frameToPng(this.els.previewVideo);
    }
    blobPromise.then(function (blob) {
      if (!blob) throw new Error('empty');
      AVR.downloadBlob(blob, 'Snapshot ' + AVR.stamp() + '.png');
      self.flash();
    }).catch(function () {
      AVR.toast('Could not capture an image.', 'error');
    });
  };

  App.prototype.frameToPng = function (video) {
    return new Promise(function (resolve, reject) {
      var w = video.videoWidth;
      var h = video.videoHeight;
      if (!w || !h) return reject(new Error('No picture'));
      var c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      c.getContext('2d').drawImage(video, 0, 0, w, h);
      c.toBlob(resolve, 'image/png');
    });
  };

  App.prototype.flash = function () {
    var f = this.els.stageFlash;
    f.classList.remove('go');
    void f.offsetWidth;
    f.classList.add('go');
  };

  // ---------------------------------------------------------------- review

  App.prototype.showReview = function (info, blob) {
    this.clearReview();
    var e = this.els;
    this.review = {
      id: info.id,
      name: info.name,
      ext: info.ext,
      kind: info.kind || (info.mode === 'audio' ? 'audio' : 'video'),
      durationMs: info.durationMs,
      blob: blob,
      url: URL.createObjectURL(blob),
      saved: info.saved !== false,
    };
    this.teardownPipeline();
    e.playbackVideo.src = this.review.url;
    e.playbackVideo.hidden = false;
    e.stage.classList.toggle('is-audio', this.review.kind === 'audio');
    var self = this;
    e.playbackVideo.onloadedmetadata = function () { self.updateStageAspect(); };
    this.setState('review');
  };

  App.prototype.clearReview = function () {
    var e = this.els;
    if (this.review) {
      URL.revokeObjectURL(this.review.url);
      this.review = null;
    }
    e.playbackVideo.onloadedmetadata = null;
    e.playbackVideo.pause();
    e.playbackVideo.removeAttribute('src');
    try { e.playbackVideo.load(); } catch (err) { /* ignore */ }
    e.playbackVideo.hidden = true;
    e.stage.classList.remove('is-audio');
  };

  App.prototype.reviewFileName = function (ext) {
    return AVR.safeFilename(this.review.name) + '.' + (ext || this.review.ext);
  };

  App.prototype.downloadReview = function () {
    if (!this.review) return;
    AVR.downloadBlob(this.review.blob, this.reviewFileName());
  };

  App.prototype.shareReview = function () {
    var r = this.review;
    if (!r) return;
    var name = this.reviewFileName();
    if (!AVR.canShareFile(r.blob, name)) {
      AVR.toast('This device cannot share this file. Use Download instead.', 'warning');
      return;
    }
    AVR.shareFile(r.blob, name, r.name).catch(function (err) {
      if (err && err.name === 'AbortError') return;
      AVR.toast('Sharing failed: ' + ((err && err.message) || 'unknown error'), 'error');
    });
  };

  App.prototype.saveReviewFrame = function () {
    var self = this;
    if (!this.review || this.review.kind === 'audio') return;
    this.frameToPng(this.els.playbackVideo).then(function (blob) {
      var t = AVR.formatDuration(self.els.playbackVideo.currentTime * 1000).replace(/:/g, '.');
      AVR.downloadBlob(blob, AVR.safeFilename(self.review.name + ' frame ' + t) + '.png');
      self.flash();
    }).catch(function () {
      AVR.toast('Play or seek the video to the frame you want first.', 'info');
    });
  };

  App.prototype.reviewWav = function () {
    var self = this;
    var r = this.review;
    if (!r) return;
    var btn = this.els.wavBtn;
    btn.disabled = true;
    btn.classList.add('busy');
    AVR.wav.fromBlob(r.blob).then(function (wav) {
      AVR.downloadBlob(wav, self.reviewFileName('wav'));
    }).catch(function () {
      AVR.toast('Could not convert this recording to WAV in this browser.', 'error');
    }).then(function () {
      btn.disabled = false;
      btn.classList.remove('busy');
    });
  };

  App.prototype.deleteReview = function () {
    var r = this.review;
    if (!r) return;
    if (!window.confirm('Delete this recording? This cannot be undone.')) return;
    var self = this;
    AVR.store.deleteRecording(r.id).catch(function () {}).then(function () {
      self.library.refresh();
      self.newRecording(false);
    });
  };

  App.prototype.newRecording = function (autoPreview) {
    this.clearReview();
    this.setState('idle');
    if (autoPreview !== false && !MODES[S.mode].screen) this.startPreview();
  };

  App.prototype.openFromLibrary = function (rec) {
    var self = this;
    if (LIVE_STATES[this.state] || this.state === 'starting') {
      AVR.toast('Stop the current recording first.', 'info');
      return;
    }
    this.library.loadBlob(rec).then(function (blob) {
      self.startToken++;
      self.releaseAll();
      self.showReview({
        id: rec.id,
        name: rec.name,
        ext: rec.ext,
        kind: rec.kind,
        mode: rec.mode,
        durationMs: rec.durationMs,
        saved: true,
      }, blob);
      self.els.stage.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      AVR.playSafely(self.els.playbackVideo);
    }).catch(function (err) {
      AVR.toast(err.message || 'Could not open the recording.', 'error');
      self.library.refresh();
    });
  };

  App.prototype.onRecordingDeleted = function (id) {
    if (this.review && this.review.id === id) this.newRecording(false);
  };

  App.prototype.onRecordingRenamed = function (id, name) {
    if (this.review && this.review.id === id) {
      this.review.name = name;
      this.render();
    }
  };

  // ---------------------------------------------------------------- misc

  App.prototype.setPrompterVisible = function (visible) {
    S.prompter.visible = !!visible;
    AVR.saveSettings();
    this.els.prompterVisible.checked = !!visible;
    this.prompter.show(!!visible);
    this.render();
  };

  App.prototype.acquireWakeLock = function () {
    var self = this;
    if (!P.hasWakeLock || this.wakeLock || document.visibilityState !== 'visible') return;
    this.wakeLock = 'pending';
    navigator.wakeLock.request('screen').then(function (lock) {
      if (!LIVE_STATES[self.state] && self.state !== 'preview') {
        lock.release().catch(function () {});
        self.wakeLock = null;
        return;
      }
      self.wakeLock = lock;
      lock.addEventListener('release', function () { if (self.wakeLock === lock) self.wakeLock = null; });
    }).catch(function () { self.wakeLock = null; });
  };

  App.prototype.releaseWakeLock = function () {
    var lock = this.wakeLock;
    this.wakeLock = null;
    if (lock && lock !== 'pending' && lock.release) lock.release().catch(function () {});
  };

  App.prototype.setState = function (state) {
    this.state = state;
    if (state === 'idle' || state === 'review') this.releaseWakeLock();
    if (!LIVE_STATES[state]) document.title = BASE_TITLE;
    this.render();
  };

  // One place that maps state to what is on screen.
  App.prototype.render = function () {
    var e = this.els;
    var st = this.state;
    var mode = S.mode;
    var m = MODES[mode];
    var live = st === 'recording' || st === 'paused';
    var hasPreview = st === 'preview' || st === 'countdown' || live;

    e.stage.dataset.state = st;
    e.stagePlaceholder.hidden = st !== 'idle';
    e.stageBusy.hidden = !(st === 'starting' || st === 'saving');
    e.busyText.textContent = st === 'saving' ? 'Saving your recording…' : (m.screen && !this.src.screen ? 'Waiting for you to choose what to share…' : 'Starting…');
    e.previewBtn.disabled = this.blocked;
    if (st !== 'countdown') e.countdownOverlay.hidden = true;

    e.recBadge.hidden = !live;
    e.recBadge.classList.toggle('paused', st === 'paused');
    e.recBadgeLabel.textContent = st === 'paused' ? (this.autoPaused ? 'PAUSED (interrupted)' : 'PAUSED') : 'REC';
    e.stageHint.hidden = !(st === 'preview' && this.compositor && this.compositor.layout === 'bubble' && !this.cameraHidden);

    // Control bar
    e.controlBar.hidden = st === 'review';
    e.reviewBar.hidden = st !== 'review';
    e.meterRow.hidden = st === 'review' || st === 'idle';
    e.recSize.hidden = !live;

    e.recordBtn.disabled = this.blocked || st === 'starting' || st === 'saving';
    e.recordBtn.classList.toggle('recording', live);
    e.recordBtn.classList.toggle('counting', st === 'countdown');
    e.recordBtn.setAttribute('aria-label',
      live ? 'Stop recording (R)' : st === 'countdown' ? 'Cancel countdown (Esc)' : 'Start recording (R)');

    e.pauseBtn.disabled = !live;
    e.pauseBtn.innerHTML = AVR.icon(st === 'paused' ? 'play-fill' : 'pause-fill') +
      '<span class="ctl-label">' + (st === 'paused' ? 'Resume' : 'Pause') + '</span>';
    e.pauseBtn.classList.toggle('active', st === 'paused');

    var hasMic = !!this.src.mic;
    e.muteBtn.disabled = !hasMic;
    e.muteBtn.setAttribute('aria-pressed', String(this.muted));
    e.muteBtn.classList.toggle('danger', this.muted);
    e.muteBtn.innerHTML = AVR.icon(this.muted ? 'microphone-slash-fill' : 'microphone') +
      '<span class="ctl-label">' + (this.muted ? 'Unmute' : 'Mute') + '</span>';

    var bubble = !!(this.compositor && this.compositor.layout === 'bubble');
    e.camToggleBtn.hidden = mode !== 'screencam';
    e.camToggleBtn.disabled = !bubble;
    e.camToggleBtn.setAttribute('aria-pressed', String(this.cameraHidden));
    e.camToggleBtn.innerHTML = AVR.icon(this.cameraHidden ? 'camera' : 'camera-slash') +
      '<span class="ctl-label">' + (this.cameraHidden ? 'Show cam' : 'Hide cam') + '</span>';

    e.flipBtn.hidden = !(P.isMobile && m.cam && (this.cameraCount || 0) !== 1);
    e.flipBtn.disabled = live || st === 'countdown' || st === 'starting';

    e.snapshotBtn.disabled = mode === 'audio' || !hasPreview;
    e.prompterBtn.setAttribute('aria-pressed', String(!!S.prompter.visible));
    e.prompterBtn.classList.toggle('active', !!S.prompter.visible);

    e.popoutBtn.hidden = !(AVR.FloatingControls.supported() && m.screen);
    e.popoutBtn.classList.toggle('active', this.floating.isOpen());

    // Settings that cannot change mid-recording
    var lock = live || st === 'countdown' || st === 'saving' || st === 'starting';
    var lockModes = live || st === 'countdown' || st === 'saving';
    [e.videoSource, e.audioSource, e.resolution, e.fps, e.quality, e.aspect, e.videoFormat, e.audioFormat,
      e.noiseSuppression, e.echoCancellation, e.autoGainControl, e.systemAudio].forEach(function (el) { el.disabled = lock; });
    e.micGain.disabled = live && !this.mixer;
    $$('.mode-tab').forEach(function (tab) { tab.classList.toggle('locked', lockModes); });

    // Floating panel
    var fp = e.floatPanel;
    var fRecord = $('[data-float="record"]', fp);
    var fPause = $('[data-float="pause"]', fp);
    var fMute = $('[data-float="mute"]', fp);
    var fCam = $('[data-float="camera"]', fp);
    e.floatStatus.classList.toggle('live', live);
    e.floatStatus.classList.toggle('paused', st === 'paused');
    if (!live && st !== 'countdown') e.floatTime.textContent = st === 'saving' ? 'Saving…' : 'Ready';
    fRecord.innerHTML = AVR.icon(live ? 'stop-fill' : 'record-fill') + '<span class="ctl-label">' + (live ? 'Stop' : 'Record') + '</span>';
    fRecord.disabled = !(live || st === 'preview' || st === 'countdown');
    fPause.disabled = !live;
    fPause.innerHTML = AVR.icon(st === 'paused' ? 'play-fill' : 'pause-fill') + '<span class="ctl-label">' + (st === 'paused' ? 'Resume' : 'Pause') + '</span>';
    fMute.disabled = !hasMic;
    fMute.classList.toggle('danger', this.muted);
    fMute.innerHTML = AVR.icon(this.muted ? 'microphone-slash-fill' : 'microphone') + '<span class="ctl-label">' + (this.muted ? 'Unmute' : 'Mute') + '</span>';
    fCam.hidden = !bubble;
    fCam.innerHTML = AVR.icon(this.cameraHidden ? 'camera' : 'camera-slash') + '<span class="ctl-label">Cam</span>';

    // Review
    if (st === 'review' && this.review) {
      var r = this.review;
      e.reviewInfo.innerHTML = '';
      var strong = document.createElement('strong');
      strong.textContent = r.name;
      e.reviewInfo.appendChild(strong);
      e.reviewInfo.appendChild(document.createTextNode(
        ' · ' + AVR.formatDuration(r.durationMs) + ' · ' + AVR.formatBytes(r.blob.size) + ' · ' + String(r.ext).toUpperCase() +
        (r.saved ? '' : ' · not saved in browser, download it now')));
      e.shareBtn.hidden = !AVR.canShareFile(r.blob, this.reviewFileName());
      e.frameBtn.hidden = r.kind === 'audio';
    }

    this.updateStageAspect();
  };

  function boot() {
    if (!AVR.app) AVR.app = new App();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window.AVR = window.AVR || {});
