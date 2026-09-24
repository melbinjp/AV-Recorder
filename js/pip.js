// Floating controls: a small always-on-top window (Document Picture-in-Picture,
// Chrome and Edge on desktop) holding the timer, pause/stop/mute buttons and,
// optionally, the teleprompter. While you record another app or window, the
// recorder's own tab is out of sight, and this keeps the controls in reach.
(function (AVR) {
  'use strict';

  function FloatingControls(panel) {
    this.panel = panel;
    this.anchor = document.createComment('floating-controls');
    this.win = null;
    this.onClose = null;
    this.onOpen = null;
  }

  FloatingControls.supported = function () {
    return 'documentPictureInPicture' in window && window.self === window.top;
  };

  FloatingControls.prototype.isOpen = function () {
    return !!this.win && !this.win.closed;
  };

  function copyStyles(target) {
    AVR.$$('link[rel="stylesheet"], style').forEach(function (node) {
      var clone = node.cloneNode(true);
      // The floating window's URL is about:blank, so relative links would break.
      if (node.href) clone.href = node.href;
      target.head.appendChild(clone);
    });
  }

  // Must be called from a click or key press.
  FloatingControls.prototype.open = function (opts) {
    var self = this;
    if (this.isOpen()) return Promise.resolve(this.win);
    if (!FloatingControls.supported()) return Promise.reject(new Error('Floating controls are not supported in this browser.'));
    var tall = opts && opts.tall;
    return window.documentPictureInPicture.requestWindow({
      width: 400,
      height: tall ? 460 : 150,
    }).then(function (win) {
      self.win = win;
      var doc = win.document;
      doc.title = 'Recorder controls';
      doc.documentElement.className = document.documentElement.className;
      copyStyles(doc);
      var sprite = document.getElementById('icon-sprite');
      if (sprite) doc.body.appendChild(sprite.cloneNode(true));
      doc.body.classList.add('pip-body');
      self.panel.parentNode.insertBefore(self.anchor, self.panel);
      doc.body.appendChild(self.panel);
      self.panel.hidden = false;
      win.addEventListener('pagehide', function () { self._restore(); });
      if (self.onOpen) self.onOpen(win);
      return win;
    });
  };

  FloatingControls.prototype._restore = function () {
    if (!this.win) return;
    this.win = null;
    if (this.anchor.parentNode) {
      this.anchor.parentNode.insertBefore(this.panel, this.anchor);
      this.anchor.parentNode.removeChild(this.anchor);
    }
    this.panel.hidden = true;
    if (this.onClose) this.onClose();
  };

  FloatingControls.prototype.close = function () {
    if (this.win) {
      try { this.win.close(); } catch (e) { /* already closed */ }
      this._restore();
    }
  };

  AVR.FloatingControls = FloatingControls;
})(window.AVR = window.AVR || {});
