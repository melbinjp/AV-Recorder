// Draws video sources onto a canvas and exposes the result as a video track.
//
// Two layouts:
//  - "bubble": a screen capture with the camera in a draggable circle/box on top
//  - "fill":   one source cropped to a chosen aspect ratio (e.g. 9:16 for Shorts)
//
// The draw loop is clocked by a Web Worker, not requestAnimationFrame. When you
// record your screen, this tab is usually in the background, where browsers
// pause animation frames and slow timers to once a second. Messages from a
// worker are not throttled that way, so the recording keeps its frame rate.
(function (AVR) {
  'use strict';

  var TICKER_SRC =
    'var t=0;onmessage=function(e){clearInterval(t);if(e.data>0)t=setInterval(function(){postMessage(0)},e.data)};';

  function Ticker(fps, fn) {
    this.worker = null;
    this.url = null;
    this.timer = 0;
    var interval = Math.max(8, Math.round(1000 / fps));
    try {
      this.url = URL.createObjectURL(new Blob([TICKER_SRC], { type: 'text/javascript' }));
      this.worker = new Worker(this.url);
      this.worker.onmessage = fn;
      this.worker.postMessage(interval);
    } catch (e) {
      this.worker = null;
      this.timer = setInterval(fn, interval);
    }
  }

  Ticker.prototype.stop = function () {
    if (this.worker) {
      try { this.worker.postMessage(0); this.worker.terminate(); } catch (e) { /* ignore */ }
    }
    if (this.url) URL.revokeObjectURL(this.url);
    clearInterval(this.timer);
    this.worker = null;
  };

  var BUBBLE_SIZES = { s: 0.24, m: 0.32, l: 0.42 };

  function even(n) {
    return Math.max(2, Math.round(n / 2) * 2);
  }

  function ready(video) {
    return video && video.readyState >= 2 && video.videoWidth > 0;
  }

  function drawCover(ctx, video, x, y, w, h, mirror) {
    var vw = video.videoWidth;
    var vh = video.videoHeight;
    var scale = Math.max(w / vw, h / vh);
    var sw = w / scale;
    var sh = h / scale;
    var sx = (vw - sw) / 2;
    var sy = (vh - sh) / 2;
    if (mirror) {
      ctx.save();
      ctx.translate(x + w, y);
      ctx.scale(-1, 1);
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
      ctx.restore();
    } else {
      ctx.drawImage(video, sx, sy, sw, sh, x, y, w, h);
    }
  }

  function drawContain(ctx, video, W, H) {
    var vw = video.videoWidth;
    var vh = video.videoHeight;
    var scale = Math.min(W / vw, H / vh);
    var w = vw * scale;
    var h = vh * scale;
    ctx.drawImage(video, (W - w) / 2, (H - h) / 2, w, h);
  }

  function roundedRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function shapePath(ctx, r, shape) {
    if (shape === 'circle') {
      ctx.beginPath();
      ctx.arc(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, 0, Math.PI * 2);
      ctx.closePath();
    } else {
      roundedRect(ctx, r.x, r.y, r.w, r.h, Math.min(r.w, r.h) * (shape === 'rounded' ? 0.2 : 0.06));
    }
  }

  // opts: {width, height, fps, layout, main, camera, bubble, mirror}
  function Compositor(opts) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'stage-canvas';
    this.canvas.width = even(opts.width);
    this.canvas.height = even(opts.height);
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.fps = opts.fps || 30;
    this.layout = opts.layout || 'bubble';
    this.main = opts.main || null;
    this.camera = opts.camera || null;
    this.bubble = opts.bubble || { size: 'm', shape: 'circle', x: 1, y: 1 };
    this.mirror = !!opts.mirror;
    this.showCamera = true;
    this.stream = null;
    this.ticker = null;
    this.drag = null;
    this.onBubbleMoved = null;
    this._bindPointer();
  }

  Compositor.even = even;

  // Largest size with the source's aspect ratio whose long side is <= maxLong.
  Compositor.fitSize = function (w, h, maxLong) {
    var s = Math.min(1, maxLong / Math.max(w, h));
    return { width: even(w * s), height: even(h * s) };
  };

  // Largest crop of a w x h source with the given aspect (width / height),
  // scaled so its long side is <= maxLong.
  Compositor.cropSize = function (w, h, aspect, maxLong) {
    var cw = w;
    var ch = w / aspect;
    if (ch > h) {
      ch = h;
      cw = h * aspect;
    }
    return Compositor.fitSize(cw, ch, maxLong);
  };

  Compositor.prototype.start = function () {
    var self = this;
    this.draw();
    this.ticker = new Ticker(this.fps, function () { self.draw(); });
  };

  Compositor.prototype.captureStream = function () {
    if (!this.stream) {
      var fn = this.canvas.captureStream || this.canvas.mozCaptureStream;
      if (!fn) throw new Error('This browser cannot record a canvas.');
      this.stream = fn.call(this.canvas, this.fps);
    }
    return this.stream;
  };

  Compositor.prototype.bubbleRect = function () {
    var W = this.canvas.width;
    var H = this.canvas.height;
    var base = Math.min(W, H);
    var frac = BUBBLE_SIZES[this.bubble.size] || BUBBLE_SIZES.m;
    var w;
    var h;
    if (this.bubble.shape === 'rect') {
      h = base * frac * 0.8;
      w = (h * 16) / 9;
    } else {
      w = h = base * frac;
    }
    var margin = base * 0.03;
    var x = margin + (W - w - 2 * margin) * this.bubble.x;
    var y = margin + (H - h - 2 * margin) * this.bubble.y;
    return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), margin: margin };
  };

  Compositor.prototype.draw = function () {
    var ctx = this.ctx;
    var W = this.canvas.width;
    var H = this.canvas.height;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    if (ready(this.main)) {
      if (this.layout === 'fill') drawCover(ctx, this.main, 0, 0, W, H, false);
      else drawContain(ctx, this.main, W, H);
    }

    if (this.layout === 'bubble' && this.showCamera && ready(this.camera)) {
      var r = this.bubbleRect();
      var shape = this.bubble.shape;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.45)';
      ctx.shadowBlur = Math.round(r.h * 0.08);
      ctx.shadowOffsetY = Math.round(r.h * 0.02);
      shapePath(ctx, r, shape);
      ctx.fillStyle = '#111';
      ctx.fill();
      ctx.restore();

      ctx.save();
      shapePath(ctx, r, shape);
      ctx.clip();
      drawCover(ctx, this.camera, r.x, r.y, r.w, r.h, this.mirror);
      ctx.restore();

      ctx.save();
      shapePath(ctx, r, shape);
      ctx.lineWidth = Math.max(2, Math.round(r.h * 0.022));
      ctx.strokeStyle = 'rgba(255,255,255,0.92)';
      ctx.stroke();
      ctx.restore();
    }
  };

  Compositor.prototype.snapshot = function (type) {
    var canvas = this.canvas;
    return new Promise(function (resolve) {
      canvas.toBlob(function (b) { resolve(b); }, type || 'image/png', 0.92);
    });
  };

  // Lets the camera bubble be dragged around the preview with mouse or touch.
  Compositor.prototype._bindPointer = function () {
    var self = this;
    var c = this.canvas;

    function toCanvas(e) {
      var rect = c.getBoundingClientRect();
      var scale = Math.min(rect.width / c.width, rect.height / c.height) || 1;
      var ox = (rect.width - c.width * scale) / 2;
      var oy = (rect.height - c.height * scale) / 2;
      return { x: (e.clientX - rect.left - ox) / scale, y: (e.clientY - rect.top - oy) / scale };
    }

    function over(p) {
      if (self.layout !== 'bubble' || !self.showCamera || !ready(self.camera)) return false;
      var r = self.bubbleRect();
      return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
    }

    c.addEventListener('pointerdown', function (e) {
      var p = toCanvas(e);
      if (!over(p)) return;
      var r = self.bubbleRect();
      self.drag = { dx: p.x - r.x, dy: p.y - r.y, id: e.pointerId };
      try { c.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      c.classList.add('dragging');
      e.preventDefault();
    });

    c.addEventListener('pointermove', function (e) {
      var p = toCanvas(e);
      if (!self.drag) {
        c.style.cursor = over(p) ? 'grab' : '';
        return;
      }
      var r = self.bubbleRect();
      var W = c.width;
      var H = c.height;
      var freeW = W - r.w - 2 * r.margin;
      var freeH = H - r.h - 2 * r.margin;
      self.bubble.x = freeW > 0 ? Math.min(1, Math.max(0, (p.x - self.drag.dx - r.margin) / freeW)) : 0;
      self.bubble.y = freeH > 0 ? Math.min(1, Math.max(0, (p.y - self.drag.dy - r.margin) / freeH)) : 0;
      self.draw();
    });

    function end() {
      if (!self.drag) return;
      self.drag = null;
      c.classList.remove('dragging');
      if (self.onBubbleMoved) self.onBubbleMoved();
    }
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
  };

  Compositor.prototype.stop = function () {
    if (this.ticker) this.ticker.stop();
    this.ticker = null;
    if (this.stream) this.stream.getTracks().forEach(function (t) { t.stop(); });
    this.stream = null;
    if (this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
  };

  AVR.Compositor = Compositor;
})(window.AVR = window.AVR || {});
