// Web Audio plumbing: level meters, and mixing the microphone with system audio.
//
// Mixing matters because MediaRecorder records only the first audio track of a
// stream. Handing it a screen's audio track and a microphone track separately
// silently drops one of them, so both are mixed into a single track first.
//
// Nothing here is ever connected audibly to the speakers, so there is no
// feedback loop. Meters feed a muted gain node, which keeps them processing in
// browsers that skip nodes not connected to the output.
(function (AVR) {
  'use strict';

  function AudioEngine() {
    this.ctx = null;
    this.sink = null;
  }

  AudioEngine.prototype.context = function () {
    if (this.ctx && this.ctx.state !== 'closed') return this.ctx;
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    // No forced sampleRate: Firefox refuses to connect a microphone whose rate
    // differs from the context's.
    try {
      this.ctx = new Ctx({ latencyHint: 'interactive' });
    } catch (e) {
      try { this.ctx = new Ctx(); } catch (e2) { return null; }
    }
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;
    this.sink.connect(this.ctx.destination);
    return this.ctx;
  };

  // Must be called from a user gesture at least once (autoplay policies).
  AudioEngine.prototype.resume = function () {
    var ctx = this.context();
    if (ctx && ctx.state !== 'running') {
      try { ctx.resume().catch(function () {}); } catch (e) { /* ignore */ }
    }
    return ctx;
  };

  AudioEngine.prototype.meter = function (track) {
    var ctx = this.context();
    if (!ctx || !track) return null;
    try {
      return new Meter(this, track);
    } catch (e) {
      return null;
    }
  };

  AudioEngine.prototype.mixer = function (opts) {
    var ctx = this.resume();
    if (!ctx || !ctx.createMediaStreamDestination) return null;
    try {
      return new Mixer(this, opts);
    } catch (e) {
      return null;
    }
  };

  function Meter(engine, track) {
    var ctx = engine.ctx;
    this.source = ctx.createMediaStreamSource(new MediaStream([track]));
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.6;
    this.source.connect(this.analyser);
    this.analyser.connect(engine.sink);
    this.floats = this.analyser.getFloatTimeDomainData ? new Float32Array(this.analyser.fftSize) : null;
    this.bytes = new Uint8Array(this.analyser.fftSize);
    this.freq = new Uint8Array(this.analyser.frequencyBinCount);
  }

  // Returns {peak, rms} as linear values in 0..1.
  Meter.prototype.read = function () {
    var peak = 0;
    var sum = 0;
    var n;
    if (this.floats) {
      this.analyser.getFloatTimeDomainData(this.floats);
      n = this.floats.length;
      for (var i = 0; i < n; i++) {
        var v = this.floats[i];
        var a = v < 0 ? -v : v;
        if (a > peak) peak = a;
        sum += v * v;
      }
    } else {
      this.analyser.getByteTimeDomainData(this.bytes);
      n = this.bytes.length;
      for (var j = 0; j < n; j++) {
        var s = (this.bytes[j] - 128) / 128;
        var b = s < 0 ? -s : s;
        if (b > peak) peak = b;
        sum += s * s;
      }
    }
    return { peak: Math.min(1, peak), rms: Math.sqrt(sum / n) };
  };

  Meter.prototype.spectrum = function () {
    this.analyser.getByteFrequencyData(this.freq);
    return this.freq;
  };

  Meter.prototype.dispose = function () {
    try { this.source.disconnect(); } catch (e) { /* already gone */ }
    try { this.analyser.disconnect(); } catch (e) { /* already gone */ }
  };

  function Mixer(engine, opts) {
    var ctx = engine.ctx;
    this.dest = ctx.createMediaStreamDestination();
    this.nodes = [];
    this.micGain = null;
    this.gainValue = opts.micGain == null ? 1 : opts.micGain;
    this.muted = false;
    if (opts.mic) {
      var micSrc = ctx.createMediaStreamSource(new MediaStream([opts.mic]));
      this.micGain = ctx.createGain();
      this.micGain.gain.value = this.gainValue;
      micSrc.connect(this.micGain);
      this.micGain.connect(this.dest);
      this.nodes.push(micSrc, this.micGain);
    }
    if (opts.system) {
      var sysSrc = ctx.createMediaStreamSource(new MediaStream([opts.system]));
      sysSrc.connect(this.dest);
      this.nodes.push(sysSrc);
    }
    this.track = this.dest.stream.getAudioTracks()[0];
  }

  Mixer.prototype.setMicGain = function (g) {
    this.gainValue = g;
    if (this.micGain && !this.muted) this.micGain.gain.value = g;
  };

  Mixer.prototype.setMicMuted = function (muted) {
    this.muted = muted;
    if (this.micGain) this.micGain.gain.value = muted ? 0 : this.gainValue;
  };

  Mixer.prototype.dispose = function () {
    this.nodes.forEach(function (n) { try { n.disconnect(); } catch (e) { /* ignore */ } });
    try { this.track.stop(); } catch (e) { /* ignore */ }
  };

  AVR.AudioEngine = AudioEngine;
})(window.AVR = window.AVR || {});
