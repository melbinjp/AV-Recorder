// Playback of a finished recording on the stage, and its actions: download,
// share, save a frame, export WAV, delete.
(function (AVR) {
  'use strict';

  // handlers: deleted(id), newRecording(), loaded(), flash()
  function Review(handlers) {
    this.h = handlers;
    this.item = null;
    var ids = ['stage', 'playbackVideo', 'reviewInfo', 'downloadBtn', 'shareBtn', 'frameBtn', 'wavBtn', 'deleteBtn', 'newBtn'];
    var els = {};
    ids.forEach(function (id) { els[id] = document.getElementById(id); });
    this.els = els;
    this.bind();
  }

  Review.prototype.bind = function () {
    var self = this;
    var e = this.els;
    e.downloadBtn.addEventListener('click', function () { self.download(); });
    e.shareBtn.addEventListener('click', function () { self.share(); });
    e.frameBtn.addEventListener('click', function () { self.saveFrame(); });
    e.wavBtn.addEventListener('click', function () { self.exportWav(); });
    e.deleteBtn.addEventListener('click', function () { self.remove(); });
    e.newBtn.addEventListener('click', function () { self.h.newRecording(); });
    e.playbackVideo.addEventListener('error', function () {
      if (self.item) AVR.toast('This browser cannot preview this file, but you can still download it.', 'warning');
    });
    e.playbackVideo.addEventListener('loadedmetadata', function () {
      if (self.item) self.h.loaded();
    });
  };

  // info: {id, name, ext, kind|mode, durationMs, saved}
  Review.prototype.show = function (info, blob) {
    this.clear();
    this.item = {
      id: info.id,
      name: info.name,
      ext: info.ext,
      kind: info.kind || (info.mode === 'audio' ? 'audio' : 'video'),
      durationMs: info.durationMs,
      blob: blob,
      url: URL.createObjectURL(blob),
      saved: info.saved !== false,
    };
    var e = this.els;
    e.playbackVideo.src = this.item.url;
    e.playbackVideo.hidden = false;
    e.stage.classList.toggle('is-audio', this.item.kind === 'audio');
    this.render();
  };

  Review.prototype.clear = function () {
    var e = this.els;
    if (this.item) URL.revokeObjectURL(this.item.url);
    this.item = null;
    e.playbackVideo.pause();
    e.playbackVideo.removeAttribute('src');
    try { e.playbackVideo.load(); } catch (err) { /* nothing loaded */ }
    e.playbackVideo.hidden = true;
    e.stage.classList.remove('is-audio');
  };

  Review.prototype.play = function () {
    AVR.playSafely(this.els.playbackVideo);
  };

  Review.prototype.aspect = function () {
    var v = this.els.playbackVideo;
    return v.videoWidth ? v.videoWidth / v.videoHeight : 0;
  };

  Review.prototype.rename = function (id, name) {
    if (this.item && this.item.id === id) {
      this.item.name = name;
      this.render();
    }
  };

  Review.prototype.fileName = function (ext) {
    return AVR.safeFilename(this.item.name) + '.' + (ext || this.item.ext);
  };

  Review.prototype.render = function () {
    var r = this.item;
    if (!r) return;
    var e = this.els;
    e.reviewInfo.innerHTML = '';
    var strong = document.createElement('strong');
    strong.textContent = r.name;
    e.reviewInfo.appendChild(strong);
    e.reviewInfo.appendChild(document.createTextNode(
      ' · ' + AVR.formatDuration(r.durationMs) + ' · ' + AVR.formatBytes(r.blob.size) + ' · ' + String(r.ext).toUpperCase() +
      (r.saved ? '' : ' · not saved in browser, download it now')));
    e.shareBtn.hidden = !AVR.canShareFile(r.blob, this.fileName());
    e.frameBtn.hidden = r.kind === 'audio';
  };

  Review.prototype.download = function () {
    if (this.item) AVR.downloadBlob(this.item.blob, this.fileName());
  };

  Review.prototype.share = function () {
    var r = this.item;
    if (!r) return;
    var name = this.fileName();
    if (!AVR.canShareFile(r.blob, name)) {
      AVR.toast('This device cannot share this file. Use Download instead.', 'warning');
      return;
    }
    AVR.shareFile(r.blob, name, r.name).catch(function (err) {
      if (err && err.name === 'AbortError') return;
      AVR.toast('Sharing failed: ' + ((err && err.message) || 'unknown error'), 'error');
    });
  };

  Review.prototype.saveFrame = function () {
    var self = this;
    var r = this.item;
    if (!r || r.kind === 'audio') return;
    var video = this.els.playbackVideo;
    AVR.frameToPng(video).then(function (blob) {
      var t = AVR.formatDuration(video.currentTime * 1000).replace(/:/g, '.');
      AVR.downloadBlob(blob, AVR.safeFilename(r.name + ' frame ' + t) + '.png');
      self.h.flash();
    }).catch(function () {
      AVR.toast('Play or seek the video to the frame you want first.', 'info');
    });
  };

  Review.prototype.exportWav = function () {
    var self = this;
    var r = this.item;
    if (!r) return;
    var btn = this.els.wavBtn;
    btn.disabled = true;
    btn.classList.add('busy');
    AVR.wav.fromBlob(r.blob).then(function (wav) {
      AVR.downloadBlob(wav, self.fileName('wav'));
    }).catch(function () {
      AVR.toast('Could not convert this recording to WAV in this browser.', 'error');
    }).then(function () {
      btn.disabled = false;
      btn.classList.remove('busy');
    });
  };

  Review.prototype.remove = function () {
    var self = this;
    var r = this.item;
    if (!r || !window.confirm('Delete this recording? This cannot be undone.')) return;
    AVR.store.deleteRecording(r.id).catch(function () {}).then(function () {
      self.h.deleted(r.id);
    });
  };

  AVR.Review = Review;
})(window.AVR = window.AVR || {});
