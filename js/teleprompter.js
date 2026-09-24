// A scrolling script overlay. It is shown on screen only and is never part of
// the recording. It can also move into the floating controls window so it stays
// readable while you record another app.
(function (AVR) {
  'use strict';

  var PLACEHOLDER = 'Paste or type your script in Settings → Teleprompter.\n\nIt scrolls while you record, so you can look at the camera and keep your place.\n\nUse the toolbar or press T to start and stop scrolling.';

  function Teleprompter(root, settings, save) {
    this.root = root;
    this.s = settings;
    this.save = save;
    this.viewport = root.querySelector('.prompter-viewport');
    this.textEl = root.querySelector('.prompter-text');
    this.speedEl = root.querySelector('[data-prompter-value="speed"]');
    this.toggleBtn = root.querySelector('[data-prompter="toggle"]');
    this.offset = 0;
    this.playing = false;
    this.last = 0;
    this.raf = 0;
    this.rafWin = null;
    this.onEdit = null;
    this.onClose = null;
    this.onStyleChange = null;
    this._bind();
    this.setText(this.s.text);
    this.applyStyle();
  }

  Teleprompter.prototype._bind = function () {
    var self = this;
    this.root.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-prompter]') : null;
      if (!btn) return;
      var action = btn.getAttribute('data-prompter');
      if (action === 'toggle') self.toggle();
      else if (action === 'reset') self.reset();
      else if (action === 'slower') self.setSpeed(self.s.speed - 1);
      else if (action === 'faster') self.setSpeed(self.s.speed + 1);
      else if (action === 'smaller') self.setFontSize(self.s.fontSize - 4);
      else if (action === 'bigger') self.setFontSize(self.s.fontSize + 4);
      else if (action === 'mirror') { self.s.mirror = !self.s.mirror; self.applyStyle(); self.save(); }
      else if (action === 'edit' && self.onEdit) self.onEdit();
      else if (action === 'close' && self.onClose) self.onClose();
    });

    // Manual scrolling with a wheel, trackpad or finger.
    this.viewport.addEventListener('wheel', function (e) {
      e.preventDefault();
      self.scrollBy(e.deltaY);
    }, { passive: false });

    var dragY = null;
    this.viewport.addEventListener('pointerdown', function (e) {
      dragY = e.clientY;
      try { self.viewport.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });
    this.viewport.addEventListener('pointermove', function (e) {
      if (dragY === null) return;
      self.scrollBy(dragY - e.clientY);
      dragY = e.clientY;
    });
    function endDrag() { dragY = null; }
    this.viewport.addEventListener('pointerup', endDrag);
    this.viewport.addEventListener('pointercancel', endDrag);
  };

  Teleprompter.prototype.setText = function (text) {
    var value = String(text || '').trim();
    this.textEl.textContent = value || PLACEHOLDER;
    this.textEl.classList.toggle('is-placeholder', !value);
    this.render();
  };

  Teleprompter.prototype.applyStyle = function () {
    this.textEl.style.fontSize = this.s.fontSize + 'px';
    this.root.classList.toggle('mirrored', !!this.s.mirror);
    if (this.speedEl) this.speedEl.textContent = String(this.s.speed);
    this.render();
    if (this.onStyleChange) this.onStyleChange();
  };

  Teleprompter.prototype.setSpeed = function (v) {
    this.s.speed = Math.min(10, Math.max(1, v));
    this.applyStyle();
    this.save();
  };

  Teleprompter.prototype.setFontSize = function (v) {
    this.s.fontSize = Math.min(72, Math.max(16, v));
    this.applyStyle();
    this.save();
  };

  Teleprompter.prototype.maxOffset = function () {
    return Math.max(0, this.textEl.scrollHeight - this.viewport.clientHeight * 0.3);
  };

  Teleprompter.prototype.scrollBy = function (dy) {
    this.offset = Math.min(this.maxOffset(), Math.max(0, this.offset + dy));
    this.render();
  };

  Teleprompter.prototype.render = function () {
    this.textEl.style.transform = 'translate3d(0,' + -Math.round(this.offset) + 'px,0)';
    if (this.toggleBtn) {
      this.toggleBtn.innerHTML = AVR.icon(this.playing ? 'pause-fill' : 'play-fill');
      this.toggleBtn.setAttribute('aria-label', this.playing ? 'Pause scrolling' : 'Start scrolling');
    }
  };

  // Speed is in lines per second, so it feels the same at any text size.
  Teleprompter.prototype.pixelsPerSecond = function () {
    return this.s.speed * 0.12 * this.s.fontSize * 1.45;
  };

  Teleprompter.prototype.play = function () {
    if (this.playing) return;
    if (this.offset >= this.maxOffset() - 1) this.offset = 0;
    this.playing = true;
    this.last = 0;
    this._loop();
    this.render();
  };

  Teleprompter.prototype._loop = function () {
    var self = this;
    // Use the animation clock of whichever window currently shows the prompter.
    var win = this.root.ownerDocument.defaultView || window;
    this.rafWin = win;
    this.raf = win.requestAnimationFrame(function step(ts) {
      if (!self.playing) return;
      if (self.last) {
        var dt = Math.min(0.1, (ts - self.last) / 1000);
        self.offset += self.pixelsPerSecond() * dt;
        if (self.offset >= self.maxOffset()) {
          self.offset = self.maxOffset();
          self.pause();
          return;
        }
        self.render();
      }
      self.last = ts;
      self.raf = win.requestAnimationFrame(step);
    });
  };

  Teleprompter.prototype.pause = function () {
    this.playing = false;
    if (this.rafWin && this.raf) {
      try { this.rafWin.cancelAnimationFrame(this.raf); } catch (e) { /* window closed */ }
    }
    this.raf = 0;
    this.render();
  };

  Teleprompter.prototype.toggle = function () {
    if (this.playing) this.pause();
    else this.play();
  };

  Teleprompter.prototype.reset = function () {
    this.offset = 0;
    this.render();
  };

  // Call after moving the prompter to another window.
  Teleprompter.prototype.rehost = function () {
    if (!this.playing) return;
    this.pause();
    this.play();
  };

  Teleprompter.prototype.show = function (visible) {
    this.root.hidden = !visible;
    if (!visible) this.pause();
    else this.render();
  };

  AVR.Teleprompter = Teleprompter;
})(window.AVR = window.AVR || {});
