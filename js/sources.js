// Capture sources: the camera, the microphone and the shared screen.
//
// Owns getting them (with the right constraints and sensible fallbacks),
// holding them, listening to their tracks, and releasing them. It knows nothing
// about the UI: the app reacts through the onEnded / onMute callbacks.
(function (AVR) {
  'use strict';

  var S = AVR.settings;
  var P = AVR.platform;

  // Errors worth one retry with plainer constraints: the saved device has gone,
  // the camera can't do the requested size, or the device was briefly busy.
  var RETRYABLE = { OverconstrainedError: 1, NotFoundError: 1, NotReadableError: 1, AbortError: 1 };

  function stopStream(stream) {
    if (!stream) return;
    stream.getTracks().forEach(function (t) {
      try { t.stop(); } catch (e) { /* already stopped */ }
    });
  }

  function firstTrack(stream, kind) {
    if (!stream) return null;
    var list = kind === 'audio' ? stream.getAudioTracks() : stream.getVideoTracks();
    return list[0] || null;
  }

  function gum(constraints) {
    return navigator.mediaDevices.getUserMedia(constraints);
  }

  function Sources(handlers) {
    this.src = { screen: null, cam: null, mic: null };
    this.handlers = handlers || {};
  }

  Sources.stopStream = stopStream;
  Sources.firstTrack = firstTrack;

  Sources.prototype.get = function (kind) {
    return this.src[kind];
  };

  Sources.prototype.track = function (kind, type) {
    return firstTrack(this.src[kind], type || (kind === 'mic' ? 'audio' : 'video'));
  };

  Sources.prototype.isLive = function (kind) {
    var s = this.src[kind];
    return !!s && s.getTracks().some(function (t) { return t.readyState === 'live'; });
  };

  Sources.prototype.set = function (kind, stream) {
    var self = this;
    this.release(kind);
    this.src[kind] = stream || null;
    if (!stream) return;
    stream.getTracks().forEach(function (track) {
      // Events from a stream that has since been replaced are ignored.
      var current = function () { return self.src[kind] === stream; };
      track.addEventListener('ended', function () {
        if (current() && self.handlers.onEnded) self.handlers.onEnded(kind, track);
      });
      track.addEventListener('mute', function () {
        if (current() && self.handlers.onMute) self.handlers.onMute(kind, track, true);
      });
      track.addEventListener('unmute', function () {
        if (current() && self.handlers.onMute) self.handlers.onMute(kind, track, false);
      });
    });
  };

  Sources.prototype.release = function (kind) {
    var stream = this.src[kind];
    this.src[kind] = null;
    stopStream(stream);
  };

  Sources.prototype.releaseAll = function () {
    this.release('screen');
    this.release('cam');
    this.release('mic');
  };

  // ---- constraints

  Sources.prototype.videoConstraints = function () {
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

  Sources.prototype.audioConstraints = function () {
    var c = {
      echoCancellation: S.echoCancellation,
      noiseSuppression: S.noiseSuppression,
      autoGainControl: S.autoGainControl,
    };
    if (S.audioDeviceId && S.audioDeviceId !== 'none') c.deviceId = { exact: S.audioDeviceId };
    return c;
  };

  Sources.prototype.wantsMic = function () {
    return S.audioDeviceId !== 'none';
  };

  // ---- acquisition (each resolves with a MediaStream; nothing is stored)

  Sources.prototype.getCamera = function () {
    return gum({ video: this.videoConstraints(), audio: false }).catch(function (err) {
      if (!err || !RETRYABLE[err.name]) throw err;
      var loose = P.isMobile ? { facingMode: S.facingMode } : true;
      return gum({ video: loose, audio: false }).then(function (s) {
        // The saved camera is gone; forget it so the next start is clean.
        if (S.videoDeviceId) { S.videoDeviceId = ''; AVR.saveSettings(); }
        return s;
      }, function () { throw err; });
    });
  };

  Sources.prototype.getMic = function () {
    return gum({ audio: this.audioConstraints(), video: false }).catch(function (err) {
      if (!err || !RETRYABLE[err.name]) throw err;
      return gum({ audio: true, video: false }).then(function (s) {
        if (S.audioDeviceId) { S.audioDeviceId = ''; AVR.saveSettings(); }
        return s;
      }, function () { throw err; });
    });
  };

  // One permission prompt for both where possible. If the combined request
  // fails, find out which device is the problem and keep the one that works.
  // Resolves {cam, mic, micError}; rejects only if the camera fails.
  Sources.prototype.getCameraAndMic = function () {
    var self = this;
    return gum({ video: this.videoConstraints(), audio: this.audioConstraints() }).then(function (s) {
      return {
        cam: new MediaStream(s.getVideoTracks()),
        mic: s.getAudioTracks().length ? new MediaStream(s.getAudioTracks()) : null,
      };
    }, function () {
      return self.getCamera().then(function (cam) {
        return self.getMic().then(function (mic) {
          return { cam: cam, mic: mic };
        }, function (micErr) {
          return { cam: cam, mic: null, micError: micErr };
        });
      });
    });
  };

  Sources.prototype.getScreen = function () {
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

  // Applies a new size/frame rate to a live screen share without re-asking.
  Sources.prototype.retuneScreen = function () {
    var t = this.track('screen', 'video');
    if (!t || !t.applyConstraints) return Promise.resolve();
    var size = AVR.formats.presetSize(S.resolution);
    return t.applyConstraints({
      width: { max: size.long }, height: { max: size.long }, frameRate: { ideal: S.fps, max: S.fps },
    }).catch(function () { /* keep the current settings */ });
  };

  // Resolves {cams, mics, labelled}. Pseudo-devices ("default",
  // "communications") are dropped: "Default" is offered separately.
  Sources.prototype.enumerate = function () {
    var md = navigator.mediaDevices;
    if (!md || !md.enumerateDevices) return Promise.resolve({ cams: [], mics: [], labelled: false, any: false });
    return md.enumerateDevices().then(function (devices) {
      return {
        cams: devices.filter(function (d) { return d.kind === 'videoinput' && d.deviceId; }),
        mics: devices.filter(function (d) {
          return d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications';
        }),
        labelled: devices.some(function (d) { return !!d.label; }),
        any: devices.length > 0,
      };
    });
  };

  AVR.Sources = Sources;
})(window.AVR = window.AVR || {});
