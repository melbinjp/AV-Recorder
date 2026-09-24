// The level meter under the preview, its copy in the floating controls, and
// the scrolling level history shown on the stage in Audio mode.
//
// It draws on animation frames. Those stop in a hidden tab, so while the tab
// is hidden the loop runs on the floating window's frames instead (if it is
// open), which is exactly when that copy of the meter is the one on screen.
(function (AVR) {
  'use strict';

  var SILENCE = 0.001; // -60 dBFS: anything quieter reads as silence

  // els: meter, fill, peak, db, floatFill, viz (canvas)
  // opts: gain() → number, muted() → bool, recording() → bool, floatingWindow() → Window|null
  function MeterView(els, opts) {
    this.els = els;
    this.opts = opts;
    this.meter = null;
    this.frame = 0;
    this.frameWin = null;
    this.peakHold = 0;
    this.history = [];
  }

  MeterView.prototype.attach = function (meter) {
    this.detach();
    this.meter = meter;
    this.start();
  };

  MeterView.prototype.detach = function () {
    this.stop();
    if (this.meter) this.meter.dispose();
    this.meter = null;
    this.reset();
  };

  MeterView.prototype.showViz = function (visible) {
    this.els.viz.hidden = !visible;
    this.history = [];
    if (visible) this.sizeViz();
  };

  // (Re)starts the draw loop on whichever window is currently visible.
  MeterView.prototype.start = function () {
    var self = this;
    this.stop();
    if (!this.meter) return;
    var step = function () {
      self.frame = 0;
      self.draw();
      var win = window;
      if (document.visibilityState !== 'visible') {
        win = self.opts.floatingWindow() || null;
        if (!win) return; // resumes on visibilitychange
      }
      self.frameWin = win;
      self.frame = win.requestAnimationFrame(step);
    };
    step();
  };

  MeterView.prototype.stop = function () {
    if (this.frame && this.frameWin) {
      try { this.frameWin.cancelAnimationFrame(this.frame); } catch (e) { /* window closed */ }
    }
    this.frame = 0;
  };

  MeterView.prototype.reset = function () {
    var e = this.els;
    e.fill.style.transform = 'scaleX(0)';
    e.peak.style.left = '0%';
    e.db.textContent = '–∞ dB';
    e.floatFill.style.transform = 'scaleX(0)';
    e.meter.className = 'meter';
    this.peakHold = 0;
  };

  MeterView.prototype.draw = function () {
    if (!this.meter) return;
    var level = this.meter.read();
    var muted = this.opts.muted();
    var peak = muted ? 0 : Math.min(1, level.peak * this.opts.gain());
    var db = peak > SILENCE ? (20 * Math.log(peak)) / Math.LN10 : -Infinity;
    var pos = db === -Infinity ? 0 : Math.max(0, Math.min(1, (db + 60) / 60));
    this.peakHold = Math.max(pos, this.peakHold - 0.006);

    var e = this.els;
    var scale = 'scaleX(' + pos.toFixed(3) + ')';
    e.fill.style.transform = scale;
    e.floatFill.style.transform = scale;
    e.peak.style.left = (this.peakHold * 100).toFixed(1) + '%';
    var cls = db > -1 ? 'clip' : db > -9 ? 'hot' : '';
    e.meter.className = 'meter ' + cls;
    e.db.textContent = muted ? 'Muted' : db === -Infinity ? '–∞ dB' : Math.round(db) + ' dB';
    e.meter.setAttribute('aria-valuenow', db === -Infinity ? '-60' : String(Math.round(Math.max(-60, db))));
    if (!e.viz.hidden) this.drawViz(pos, cls);
  };

  MeterView.prototype.sizeViz = function () {
    var c = this.els.viz;
    if (c.hidden) return;
    var ratio = Math.min(2, window.devicePixelRatio || 1);
    var rect = c.getBoundingClientRect();
    c.width = Math.max(1, Math.round(rect.width * ratio));
    c.height = Math.max(1, Math.round(rect.height * ratio));
  };

  // A scrolling level history: easy to read at a glance, and it makes gaps
  // and clipping obvious.
  MeterView.prototype.drawViz = function (pos, cls) {
    var c = this.els.viz;
    var ctx = c.getContext('2d');
    var W = c.width;
    var H = c.height;
    if (!W || !H) return;
    var bar = Math.max(3, Math.round(W / 140));
    var gap = Math.max(1, Math.round(bar / 2));
    var max = Math.ceil(W / (bar + gap));
    this.history.push({ v: pos, cls: cls });
    if (this.history.length > max) this.history.splice(0, this.history.length - max);
    ctx.clearRect(0, 0, W, H);
    var mid = H / 2;
    var live = this.opts.recording();
    for (var i = 0; i < this.history.length; i++) {
      var item = this.history[this.history.length - 1 - i];
      var x = W - (i + 1) * (bar + gap);
      var h = Math.max(2, item.v * item.v * H * 0.9);
      ctx.fillStyle = item.cls === 'clip' ? '#ef4444' : item.cls === 'hot' ? '#f59e0b' : live ? '#f87171' : '#60a5fa';
      ctx.globalAlpha = 0.35 + 0.65 * (1 - i / max);
      ctx.fillRect(x, mid - h / 2, bar, h);
    }
    ctx.globalAlpha = 1;
  };

  AVR.MeterView = MeterView;
})(window.AVR = window.AVR || {});
