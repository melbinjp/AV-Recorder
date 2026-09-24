// The recorder's coordinator: the state machine, the preview pipeline and the
// recording flow. The parts it coordinates live in their own files:
//
//   sources.js        camera / microphone / screen capture
//   compositor.js     screen + camera bubble, aspect cropping
//   audio-engine.js   level meters, microphone + computer sound mixing
//   session.js        one recording: MediaRecorder, storage, recovery
//   meter-view.js     the level meter and audio visualizer
//   settings-panel.js the settings sidebar
//   review.js         playback of a finished recording
//   library.js        the list of saved recordings
//
// States:  idle → starting → preview → countdown → recording ⇄ paused → saving → review
//
// Rules that keep it dependable:
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
  var stopStream = AVR.Sources.stopStream;

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

  function aspectValue(aspect) {
    var parts = String(aspect).split(':');
    return parts.length === 2 ? Number(parts[0]) / Number(parts[1]) : 0;
  }

  function App() {
    var self = this;
    this.state = 'idle';
    this.engine = new AVR.AudioEngine();
    this.srcVideos = { screen: null, cam: null };
    this.compositor = null;
    this.mixer = null;
    this.session = null;
    this.muted = false;
    this.cameraHidden = false;
    this.autoPaused = false;
    this.wakeLock = null;
    this.startToken = 0;
    this.countdownTimer = null;
    this.tickTimer = null;
    this.cameraCount = null;
    this.installPrompt = null;
    this.warnedNoSystemAudio = false;
    this.take = null; // {baseName, part, startedAt}: parts of one take share a name
    this.space = { checkedAt: 0, free: 0, minutesLeft: null, warned: false };
    this.els = this.collectElements();

    this.sources = new AVR.Sources({
      onEnded: function (kind) { self.onSourceEnded(kind); },
      onMute: function (kind, track, muted) { self.onTrackMute(kind, track, muted); },
    });
    this.prompter = new AVR.Teleprompter($('#prompter'), S.prompter, AVR.saveSettings);
    this.floating = new AVR.FloatingControls($('#floatPanel'));
    this.meterView = new AVR.MeterView({
      meter: this.els.meter,
      fill: this.els.meterFill,
      peak: this.els.meterPeak,
      db: this.els.meterDb,
      floatFill: this.els.floatMeterFill,
      viz: this.els.audioViz,
    }, {
      gain: function () { return self.sources.get('mic') ? S.micGain : 1; },
      muted: function () { return self.muted && !!self.sources.get('mic'); },
      recording: function () { return self.state === 'recording'; },
      floatingWindow: function () { return self.floating.isOpen() ? self.floating.win : null; },
    });
    this.review = new AVR.Review({
      deleted: function () {
        self.library.refresh();
        self.newRecording(false);
      },
      newRecording: function () { self.newRecording(); },
      loaded: function () { self.updateStageAspect(); },
      flash: function () { self.flash(); },
    });
    this.library = new AVR.Library($('#library'), {
      onPlay: this.openFromLibrary.bind(this),
      onDeleted: function (id) { if (self.review.item && self.review.item.id === id) self.newRecording(false); },
      onRenamed: function (id, name) { self.review.rename(id, name); },
    });
    this.panel = new AVR.SettingsPanel(this.prompter, {
      videoChanged: function () { self.onVideoSettingChanged(); },
      qualityChanged: function () {},
      deviceChanged: function (kind) { self.restartSource(kind); },
      micProcessingChanged: function () { self.restartSource('mic'); },
      mirrorChanged: function () { self.applyMirror(); },
      systemAudioChanged: function () {
        if (self.sources.get('screen') && self.state === 'preview') {
          AVR.toast('This applies the next time you choose what to share.', 'info');
        }
      },
      micGainChanged: function (gain) { if (self.mixer) self.mixer.setMicGain(gain); },
      bubbleChanged: function () { if (self.compositor) self.compositor.draw(); },
      prompterVisibilityChanged: function (visible) { self.setPrompterVisible(visible); },
      outputSize: function () { return self.outputSize(); },
    });
    this.init();
  }

  App.prototype.collectElements = function () {
    var ids = [
      'envBanner', 'stage', 'previewVideo', 'canvasHost', 'audioViz', 'stagePlaceholder', 'placeholderIcon',
      'placeholderText', 'previewBtn', 'placeholderNote', 'stageBusy', 'busyText', 'countdownOverlay', 'stageFlash',
      'recBadge', 'recBadgeLabel', 'recBadgeTime', 'stageChip', 'stageHint', 'meterRow', 'meterFill', 'meterPeak',
      'meterDb', 'meter', 'meterIcon', 'recSize', 'muteBtn', 'flipBtn', 'camToggleBtn', 'recordBtn', 'pauseBtn',
      'snapshotBtn', 'prompterBtn', 'popoutBtn', 'controlBar', 'reviewBar', 'helpBtn', 'helpDialog', 'installBtn',
      'offlinePill', 'floatPanel', 'floatTime', 'floatStatus', 'floatMeterFill', 'floatPrompterSlot', 'sourceHost',
    ];
    var els = {};
    ids.forEach(function (id) { els[id] = document.getElementById(id); });
    return els;
  };

  // ---------------------------------------------------------------- startup

  App.prototype.init = function () {
    var self = this;
    this.checkEnvironment();
    this.bindModeTabs();
    this.bindControls();
    this.bindGlobalEvents();

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
    navigator.serviceWorker.register('sw.js').catch(function (err) {
      // Offline support is optional; the recorder works without it.
      AVR.log('warn', 'service-worker-failed', err);
    });
  };

  // Starts the preview without a click when that won't surprise anyone: the
  // mode needs no screen picker and the permissions were granted before.
  App.prototype.maybeAutoPreview = function () {
    var self = this;
    var mode = MODES[S.mode];
    if (this.blocked || mode.screen || this.state !== 'idle') return Promise.resolve();
    if (!navigator.permissions || !navigator.permissions.query) return Promise.resolve();
    var names = mode.cam ? ['camera'] : [];
    if (this.sources.wantsMic()) names.push('microphone');
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

    this.prompter.onEdit = function () { self.panel.openPrompterEditor(); };
    this.prompter.onClose = function () { self.setPrompterVisible(false); };

    e.floatPanel.addEventListener('click', function (ev) {
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
      self.meterView.start();
      self.render();
    };
    this.floating.onClose = function () {
      var prompterEl = document.getElementById('prompter');
      if (prompterEl && prompterEl.parentNode !== e.stage) {
        e.stage.appendChild(prompterEl);
        self.prompter.rehost();
      }
      self.render();
    };

    e.helpBtn.addEventListener('click', function () { self.openHelp(); });
    this.bindDiagnostics();
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

    window.addEventListener('resize', function () { self.meterView.sizeViz(); });
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

  App.prototype.bindDiagnostics = function () {
    var details = document.getElementById('diagnostics');
    var pre = document.getElementById('diagText');
    var copyBtn = document.getElementById('copyDiagBtn');
    document.getElementById('appVersion').textContent = AVR.VERSION;
    function refresh() {
      return AVR.diagnosticsReport().then(function (text) {
        pre.textContent = text;
        return text;
      });
    }
    details.addEventListener('toggle', function () { if (details.open) refresh(); });
    copyBtn.addEventListener('click', function () {
      refresh().then(function (text) {
        var copied = navigator.clipboard && navigator.clipboard.writeText
          ? navigator.clipboard.writeText(text)
          : Promise.reject(new Error('no clipboard'));
        return copied.catch(function () {
          // Older browsers: select the text and use the legacy copy command.
          var range = document.createRange();
          range.selectNodeContents(pre);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          if (!document.execCommand('copy')) throw new Error('copy refused');
        });
      }).then(function () {
        AVR.toast('Diagnostics copied.', 'success', { timeout: 2000 });
      }, function () {
        AVR.toast('Could not copy. Select the text and copy it by hand.', 'warning');
      });
    });
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
    if (this.state === 'review') this.review.clear();
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
    if (hadPreview && (!needs.screen || this.sources.get('screen'))) {
      this.startPreview();
    } else {
      if (!this.sources.get('screen')) this.releaseAll();
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

  // ---------------------------------------------------------------- sources

  App.prototype.refreshDevices = function () {
    var self = this;
    return this.sources.enumerate().then(function (list) {
      self.panel.setDevices(list);
      self.cameraCount = list.cams.length;
      self.render();
    }).catch(function () { /* device names are a nicety */ });
  };

  App.prototype.setSource = function (kind, stream) {
    this.releaseVideoEl(kind);
    this.sources.set(kind, stream);
    if (kind === 'mic') {
      var mic = this.sources.track('mic');
      if (mic) mic.enabled = !this.muted;
    }
  };

  App.prototype.releaseSource = function (kind) {
    this.releaseVideoEl(kind);
    this.sources.release(kind);
  };

  App.prototype.releaseAll = function () {
    this.teardownPipeline();
    this.releaseSource('screen');
    this.releaseSource('cam');
    this.releaseSource('mic');
  };

  App.prototype.hasLiveSources = function () {
    var m = MODES[S.mode];
    if (m.screen) return this.sources.isLive('screen');
    if (m.cam) return this.sources.isLive('cam');
    return this.sources.isLive('mic');
  };

  App.prototype.startPreview = function () {
    var self = this;
    if (this.blocked || LIVE_STATES[this.state]) return Promise.resolve(false);
    var mode = S.mode;
    var need = MODES[mode];
    var src = this.sources;
    var wantMic = src.wantsMic();
    var token = ++this.startToken;
    var stale = function () { return token !== self.startToken; };
    if (this.state === 'review') this.review.clear();
    this.teardownPipeline();
    this.setState('starting');
    this.setPlaceholderNote('');

    if (!need.screen) this.releaseSource('screen');
    if (!need.cam) this.releaseSource('cam');
    if (!wantMic) this.releaseSource('mic');

    var warnings = [];
    var chain = Promise.resolve();

    // Ask for the screen first, while the click still counts as a user gesture.
    if (need.screen && !src.get('screen')) {
      chain = chain.then(function () {
        return src.getScreen().then(function (s) {
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
      var needCam = need.cam && !src.get('cam');
      var needMic = wantMic && !src.get('mic');
      var screenOnly = 'Camera unavailable, so this will record the screen only. ';
      if (needCam && needMic) {
        return src.getCameraAndMic().then(function (r) {
          if (stale()) { stopStream(r.cam); stopStream(r.mic); return; }
          self.setSource('cam', r.cam);
          self.setSource('mic', r.mic);
          if (r.micError) warnings.push('Recording without a microphone. ' + AVR.describeMediaError(r.micError, 'microphone'));
        }, function (err) {
          if (mode === 'screencam') {
            warnings.push(screenOnly + AVR.describeMediaError(err, 'camera'));
            return src.getMic().then(function (mic) {
              if (stale()) { stopStream(mic); return; }
              self.setSource('mic', mic);
            }, function () {});
          }
          err.what = 'camera';
          throw err;
        });
      }
      if (needCam) {
        return src.getCamera().then(function (cam) {
          if (stale()) { stopStream(cam); return; }
          self.setSource('cam', cam);
        }, function (err) {
          if (mode === 'screencam') {
            warnings.push(screenOnly + AVR.describeMediaError(err, 'camera'));
            return;
          }
          err.what = 'camera';
          throw err;
        });
      }
      if (needMic) {
        return src.getMic().then(function (mic) {
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
      AVR.log(cancelled ? 'info' : 'warn', cancelled ? 'share-cancelled' : 'preview-failed', (what || 'source') + ' ' + ((err && err.name) || '') + ' ' + ((err && err.message) || ''));
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
    var src = this.sources;
    var getter = kind === 'cam' ? src.getCamera() : (src.wantsMic() ? src.getMic() : Promise.resolve(null));
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
    if (this.state !== 'preview') return;
    var self = this;
    this.sources.retuneScreen();
    if (MODES[S.mode].cam) this.restartSource('cam');
    else if (this.sources.get('screen')) {
      setTimeout(function () {
        if (self.state === 'preview') self.buildPipeline();
      }, 300);
    }
  };

  App.prototype.flipCamera = function () {
    if (this.state !== 'preview' && this.state !== 'idle') return;
    S.facingMode = S.facingMode === 'user' ? 'environment' : 'user';
    S.videoDeviceId = '';
    S.mirror = S.facingMode === 'user';
    AVR.saveSettings();
    this.panel.syncDevices();
    if (this.state === 'preview') this.restartSource('cam');
  };

  App.prototype.onSourceEnded = function (kind) {
    var live = this.state === 'recording' || this.state === 'paused';
    var mode = S.mode;
    AVR.log(live ? 'warn' : 'info', 'source-ended', kind + ' during ' + this.state);
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
        var cam = this.sources.track('cam');
        if (!cam || !cam.muted) {
          if (this.resume()) AVR.toast('Recording resumed.', 'success');
        }
      }
    } else if (P.isMobile && this.state === 'recording' && S.mode === 'camera') {
      if (this.pause(true)) AVR.toast('Recording paused while the app was in the background.', 'warning');
    }
    // Animation frames stop in a hidden tab; move the meter to the floating
    // window (if open) or restart it on return.
    this.meterView.start();
  };

  // ---------------------------------------------------------------- pipeline

  // A hidden <video> that feeds a source into the compositor. Started with
  // play(), not autoplay: Chrome pauses muted autoplay videos that are off
  // screen, and these are deliberately tiny and hidden.
  App.prototype.sourceVideo = function (kind) {
    if (this.srcVideos[kind]) return this.srcVideos[kind];
    var v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.srcObject = new MediaStream(this.sources.get(kind).getVideoTracks());
    this.els.sourceHost.appendChild(v);
    AVR.playSafely(v);
    this.srcVideos[kind] = v;
    return v;
  };

  App.prototype.releaseVideoEl = function (kind) {
    var v = this.srcVideos[kind];
    if (!v) return;
    v.srcObject = null;
    v.remove();
    this.srcVideos[kind] = null;
  };

  App.prototype.buildPipeline = function () {
    var self = this;
    var e = this.els;
    var mode = S.mode;
    var src = this.sources;
    this.teardownPipeline();
    var size = AVR.formats.presetSize(S.resolution);
    var waitFor = Promise.resolve();

    if (mode === 'camera' && src.get('cam')) {
      var camTrack = src.track('cam');
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
        e.previewVideo.srcObject = src.get('cam');
        e.previewVideo.hidden = false;
        AVR.playSafely(e.previewVideo);
        waitFor = AVR.waitForVideo(e.previewVideo);
      }
    } else if (mode === 'screencam' && src.get('screen') && src.get('cam')) {
      var screenVideo = this.sourceVideo('screen');
      var camVid = this.sourceVideo('cam');
      waitFor = Promise.all([AVR.waitForVideo(screenVideo), AVR.waitForVideo(camVid, 3000)]).then(function () {
        var fit = AVR.Compositor.fitSize(screenVideo.videoWidth || 1920, screenVideo.videoHeight || 1080, size.long);
        self.makeCompositor({ width: fit.width, height: fit.height, layout: 'bubble', main: screenVideo, camera: camVid });
      });
    } else if (MODES[mode].screen && src.get('screen')) {
      e.previewVideo.srcObject = new MediaStream(src.get('screen').getVideoTracks());
      e.previewVideo.hidden = false;
      AVR.playSafely(e.previewVideo);
      waitFor = AVR.waitForVideo(e.previewVideo);
    } else if (mode === 'audio') {
      this.meterView.showViz(true);
    }

    var meterTrack = src.track('mic') || src.track('screen', 'audio');
    this.meterView.attach(this.engine.meter(meterTrack));
    e.meterIcon.setAttribute('href', src.get('mic') ? '#i-microphone' : '#i-speaker-high');

    if (mode === 'camera' || mode === 'audio') this.acquireWakeLock();

    return waitFor.then(function () {
      self.applyMirror();
      self.updateStageAspect();
      self.panel.updateQualityHint();
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
    this.meterView.showViz(false);
    this.meterView.detach();
    // Source <video> elements that no longer feed anything can go.
    var m = MODES[S.mode];
    if (this.srcVideos.screen && !m.screen) this.releaseVideoEl('screen');
    if (this.srcVideos.cam && !(m.cam && (S.mode === 'screencam' || S.aspect !== 'auto'))) this.releaseVideoEl('cam');
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
    if (this.state === 'review') ratio = this.review.aspect() || 16 / 9;
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
    var src = this.sources;
    if (mode !== 'audio') {
      var video = null;
      if (this.compositor) video = AVR.Sources.firstTrack(this.compositor.captureStream(), 'video');
      else if (mode === 'camera') video = src.track('cam');
      else video = src.track('screen');
      if (video) tracks.push(video);
    }
    var mic = src.track('mic');
    var sys = src.track('screen', 'audio');
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

  // opts.nextPart: continue the current take as its next part (after a
  // recorder failure), without a countdown and without resetting the prompter.
  App.prototype.startRecording = function (opts) {
    var self = this;
    var mode = S.mode;
    var kind = mode === 'audio' ? 'audio' : 'video';
    var nextPart = !!(opts && opts.nextPart && this.take);
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
    var videoBits = kind === 'video' ? AVR.formats.videoBitrate(size.width, size.height, S.fps, S.quality) : 0;
    var audioBits = stream.getAudioTracks().length ? AVR.formats.audioBitrate(S.quality) : 0;

    if (nextPart) {
      this.take.part += 1;
    } else {
      this.take = { baseName: MODES[mode].label + ' ' + AVR.stamp(), part: 1 };
    }
    this.take.startedAt = Date.now();
    var name = this.take.baseName + (this.take.part > 1 ? ' (part ' + this.take.part + ')' : '');

    var session = new AVR.RecordingSession({
      stream: stream,
      kind: kind,
      mode: mode,
      format: format,
      videoBitsPerSecond: videoBits,
      audioBitsPerSecond: audioBits,
      width: size.width,
      height: size.height,
      name: name,
    });
    session.onerror = function (err) {
      if (self.session !== session) return;
      self.onRecorderError(session, err);
    };
    session.onwarning = function (msg) { AVR.toast(msg, 'warning', { timeout: 12000 }); };
    session.onlimit = function () {
      if (self.session !== session) return;
      AVR.toast('Out of space, so the recording was stopped and saved before anything could be lost. Download it now, then free up space.', 'error', { timeout: 20000 });
      self.stopRecording();
    };
    this.session = session;
    this.autoPaused = false;
    this.space.checkedAt = 0;
    this.space.minutesLeft = null;
    this.setState('recording');
    if (!nextPart) this.checkSpace((videoBits + audioBits) / 8, true);

    session.start().then(function () {
      if (self.session !== session) return;
      self.acquireWakeLock();
      self.startTicker();
      if (S.prompter.visible && S.prompter.autoStart) {
        if (!nextPart) self.prompter.reset();
        self.prompter.play();
      }
      setTimeout(function () { self.captureThumbnail(session); }, 1200);
      if (!nextPart) AVR.announce('Recording started');
      self.render();
    }).catch(function (err) {
      if (self.session !== session) return;
      AVR.log('error', 'record-start-failed', err);
      self.session = null;
      self.disposeMixer();
      self.setState('preview');
      AVR.toast('Could not start recording: ' + ((err && err.message) || 'this browser refused'), 'error', { timeout: 10000 });
    });
  };

  // The browser's encoder failed mid-recording (rare: a driver fault, or the
  // shared window changing in a way the encoder can't follow). Save what we
  // have and, if the sources are still live, carry on as the next part of
  // the same take. Capped, so a fault that repeats can't loop.
  App.prototype.onRecorderError = function (session, err) {
    AVR.log('error', 'recorder-error', err);
    var take = this.take;
    var canContinue = this.hasLiveSources() && take && take.part < 5 && Date.now() - take.startedAt > 3000;
    if (!canContinue) {
      AVR.toast('The recorder hit a problem (' + ((err && (err.name || err.message)) || 'unknown') + '). What was recorded so far has been saved.', 'error', { timeout: 10000 });
      this.stopRecording();
      return;
    }
    this.stopRecording({ continueTake: true });
  };

  // Estimates how many minutes of recording the device has room for, from
  // the browser's storage quota and the recording's measured (or nominal) rate.
  App.prototype.checkSpace = function (nominalBytesPerSec, beforeStart) {
    var self = this;
    this.space.checkedAt = Date.now();
    return AVR.store.status().then(function (st) {
      if (!st.available || !st.quota) return;
      var rate = (self.session && self.session.byteRate()) || nominalBytesPerSec;
      if (!rate) return;
      var free = Math.max(0, st.quota - st.usage);
      var minutes = free / rate / 60;
      self.space.free = free;
      self.space.minutesLeft = minutes;
      if (beforeStart && minutes < 10) {
        AVR.toast('This device has room for only about ' + Math.max(1, Math.floor(minutes)) +
          ' more minute' + (minutes >= 2 ? 's' : '') + ' of recording at this quality. Free up space or lower the quality.', 'warning', { timeout: 12000 });
        self.space.warned = true;
      } else if (!beforeStart && minutes < 3 && !self.space.warned) {
        self.space.warned = true;
        AVR.toast('Storage is almost full: about ' + Math.max(1, Math.round(minutes)) +
          ' minute' + (minutes >= 1.5 ? 's' : '') + ' left. If it runs out, the recording is saved automatically.', 'warning', { timeout: 12000 });
      }
      AVR.log(minutes < 10 ? 'warn' : 'info', 'space', Math.round(minutes) + ' min left, ' + AVR.formatBytes(free) + ' free');
    }).catch(function () { /* an estimate is a nicety */ });
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
    AVR.announce('Recording paused');
    if (auto) AVR.log('info', 'auto-paused');
    return true;
  };

  App.prototype.resume = function () {
    if (this.state !== 'paused' || !this.session) return false;
    if (!this.session.resume()) return false;
    this.autoPaused = false;
    if (S.prompter.visible && S.prompter.autoStart) this.prompter.play();
    this.setState('recording');
    AVR.announce('Recording resumed');
    return true;
  };

  App.prototype.togglePause = function () {
    if (this.state === 'recording') this.pause(false);
    else if (this.state === 'paused') this.resume();
  };

  App.prototype.toggleMute = function () {
    var mic = this.sources.track('mic');
    if (!mic) {
      if (!MODES[S.mode].screen) AVR.toast('No microphone is active.', 'info');
      return;
    }
    this.muted = !this.muted;
    mic.enabled = !this.muted;
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

  // opts.continueTake: save this part and immediately record the next one,
  // keeping the sources, preview and floating controls as they are.
  App.prototype.stopRecording = function (opts) {
    var self = this;
    var session = this.session;
    var continuing = !!(opts && opts.continueTake);
    if (!session || this.state === 'saving') return;
    if (!continuing) this.prompter.pause();
    this.stopTicker();
    this.setState('saving');
    function cleanUp() {
      self.session = null;
      self.disposeMixer();
      self.releaseAll();
      self.releaseWakeLock();
      self.floating.close();
    }
    session.stop().then(function (result) {
      if (continuing) {
        self.session = null;
        self.disposeMixer();
        var take = self.take;
        if (take.part === 1 && result.saved) {
          AVR.store.updateRecording(result.id, { name: take.baseName + ' (part 1)' }).catch(function () {});
        }
        self.library.refresh();
        AVR.toast('The recorder hit a problem, so part ' + take.part + ' was saved and recording carries on as part ' +
          (take.part + 1) + '. Both are in Your recordings.', 'warning', { timeout: 12000 });
        self.startRecording({ nextPart: true });
        return;
      }
      cleanUp();
      self.showReview(result, result.blob);
      self.library.refresh();
      AVR.announce('Recording saved, ' + AVR.formatDuration(result.durationMs));
      if (result.saved) {
        AVR.toast('Saved (' + AVR.formatDuration(result.durationMs) + '). It is also in Your recordings below.', 'success');
        // Now that there is something worth keeping, ask the browser not to
        // clear it under storage pressure.
        AVR.store.persist().then(function (granted) {
          AVR.log('info', 'storage-persist', granted ? 'granted' : 'not granted');
          self.library.updateStorage();
        });
      } else {
        AVR.toast('Recording ready, but it could not be saved in this browser. Download it now so you don\'t lose it.', 'warning', { timeout: 15000 });
      }
    }).catch(function (err) {
      AVR.log('error', 'record-failed', err);
      cleanUp();
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
    if (Date.now() - this.space.checkedAt > 15000) this.checkSpace(0, false);
    // Time left appears only when it is worth knowing (under an hour).
    var left = this.space.minutesLeft;
    var size = AVR.formatBytes(s.bytes);
    if (left !== null && left < 60) size += ' · ' + (left < 1 ? '<1' : Math.floor(left)) + ' min left';
    this.els.recSize.textContent = size;
    this.els.recSize.classList.toggle('low', left !== null && left < 5);
    document.title = (paused ? '❚❚ ' : '● ') + t + ' · ' + (paused ? 'Paused' : 'Recording') + ' | ' + BASE_TITLE;
  };

  // ---------------------------------------------------------------- snapshots

  App.prototype.snapshot = function () {
    var self = this;
    if (this.state === 'review') { this.review.saveFrame(); return; }
    if (S.mode === 'audio') return;
    if (!(this.state === 'preview' || this.state === 'recording' || this.state === 'paused' || this.state === 'countdown')) return;
    var blobPromise = this.compositor ? this.compositor.snapshot('image/png') : AVR.frameToPng(this.els.previewVideo);
    blobPromise.then(function (blob) {
      if (!blob) throw new Error('empty');
      AVR.downloadBlob(blob, 'Snapshot ' + AVR.stamp() + '.png');
      self.flash();
    }).catch(function () {
      AVR.toast('Could not capture an image.', 'error');
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
    this.teardownPipeline();
    this.review.show(info, blob);
    this.setState('review');
  };

  App.prototype.newRecording = function (autoPreview) {
    this.review.clear();
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
      self.review.play();
    }).catch(function (err) {
      AVR.toast(err.message || 'Could not open the recording.', 'error');
      self.library.refresh();
    });
  };

  // ---------------------------------------------------------------- misc

  App.prototype.setPrompterVisible = function (visible) {
    S.prompter.visible = !!visible;
    AVR.saveSettings();
    this.panel.syncPrompter();
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

  function setCtl(btn, icon, label) {
    btn.innerHTML = AVR.icon(icon) + '<span class="ctl-label">' + label + '</span>';
  }

  // One place that maps state to what is on screen.
  App.prototype.render = function () {
    var e = this.els;
    var st = this.state;
    var mode = S.mode;
    var m = MODES[mode];
    var live = st === 'recording' || st === 'paused';
    var hasPreview = st === 'preview' || st === 'countdown' || live;
    var hasMic = !!this.sources.get('mic');
    var bubble = !!(this.compositor && this.compositor.layout === 'bubble');

    // Stage
    e.stage.dataset.state = st;
    e.stagePlaceholder.hidden = st !== 'idle';
    e.stageBusy.hidden = !(st === 'starting' || st === 'saving');
    e.busyText.textContent = st === 'saving' ? 'Saving your recording…'
      : (m.screen && !this.sources.get('screen') ? 'Waiting for you to choose what to share…' : 'Starting…');
    e.previewBtn.disabled = this.blocked;
    if (st !== 'countdown') e.countdownOverlay.hidden = true;
    e.recBadge.hidden = !live;
    e.recBadge.classList.toggle('paused', st === 'paused');
    var part = this.take && this.take.part > 1 && live ? ' · part ' + this.take.part : '';
    e.recBadgeLabel.textContent = (st === 'paused' ? (this.autoPaused ? 'PAUSED (interrupted)' : 'PAUSED') : 'REC') + part;
    e.stageHint.hidden = !(st === 'preview' && bubble && !this.cameraHidden);

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
    setCtl(e.pauseBtn, st === 'paused' ? 'play-fill' : 'pause-fill', st === 'paused' ? 'Resume' : 'Pause');
    e.pauseBtn.classList.toggle('active', st === 'paused');

    e.muteBtn.disabled = !hasMic;
    e.muteBtn.setAttribute('aria-pressed', String(this.muted));
    e.muteBtn.classList.toggle('danger', this.muted);
    setCtl(e.muteBtn, this.muted ? 'microphone-slash-fill' : 'microphone', this.muted ? 'Unmute' : 'Mute');

    e.camToggleBtn.hidden = mode !== 'screencam';
    e.camToggleBtn.disabled = !bubble;
    e.camToggleBtn.setAttribute('aria-pressed', String(this.cameraHidden));
    setCtl(e.camToggleBtn, this.cameraHidden ? 'camera' : 'camera-slash', this.cameraHidden ? 'Show cam' : 'Hide cam');

    // Flip only helps with more than one camera; before permission the count is unknown.
    e.flipBtn.hidden = !(P.isMobile && m.cam && this.cameraCount !== 1 && this.cameraCount !== 0);
    e.flipBtn.disabled = live || st === 'countdown' || st === 'starting';

    e.snapshotBtn.disabled = mode === 'audio' || !hasPreview;
    e.prompterBtn.setAttribute('aria-pressed', String(!!S.prompter.visible));
    e.prompterBtn.classList.toggle('active', !!S.prompter.visible);

    e.popoutBtn.hidden = !(AVR.FloatingControls.supported() && m.screen);
    e.popoutBtn.classList.toggle('active', this.floating.isOpen());

    // Settings that cannot change mid-recording
    this.panel.lock(live || st === 'countdown' || st === 'saving' || st === 'starting', live && !this.mixer);
    var lockModes = live || st === 'countdown' || st === 'saving';
    $$('.mode-tab').forEach(function (tab) { tab.classList.toggle('locked', lockModes); });

    this.renderFloating(st, live, hasMic, bubble);
    if (st === 'review') this.review.render();
    this.updateStageAspect();
  };

  App.prototype.renderFloating = function (st, live, hasMic, bubble) {
    var e = this.els;
    var fp = e.floatPanel;
    var fRecord = $('[data-float="record"]', fp);
    var fPause = $('[data-float="pause"]', fp);
    var fMute = $('[data-float="mute"]', fp);
    var fCam = $('[data-float="camera"]', fp);
    e.floatStatus.classList.toggle('live', live);
    e.floatStatus.classList.toggle('paused', st === 'paused');
    if (!live && st !== 'countdown') e.floatTime.textContent = st === 'saving' ? 'Saving…' : 'Ready';
    setCtl(fRecord, live ? 'stop-fill' : 'record-fill', live ? 'Stop' : 'Record');
    fRecord.disabled = !(live || st === 'preview' || st === 'countdown');
    fPause.disabled = !live;
    setCtl(fPause, st === 'paused' ? 'play-fill' : 'pause-fill', st === 'paused' ? 'Resume' : 'Pause');
    fMute.disabled = !hasMic;
    fMute.classList.toggle('danger', this.muted);
    setCtl(fMute, this.muted ? 'microphone-slash-fill' : 'microphone', this.muted ? 'Unmute' : 'Mute');
    fCam.hidden = !bubble;
    setCtl(fCam, this.cameraHidden ? 'camera' : 'camera-slash', 'Cam');
  };

  function boot() {
    if (!AVR.app) AVR.app = new App();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window.AVR = window.AVR || {});
