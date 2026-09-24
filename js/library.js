// "Your recordings": everything recorded in this browser, saved on the device.
(function (AVR) {
  'use strict';

  var MODE_ICONS = { camera: 'video-camera', screen: 'monitor', screencam: 'user-focus', audio: 'waveform' };

  function Library(root, handlers) {
    this.root = root;
    this.handlers = handlers || {};
    this.list = root.querySelector('#libraryList');
    this.empty = root.querySelector('#libraryEmpty');
    this.storageEl = root.querySelector('#libraryStorage');
    this.clearBtn = root.querySelector('#clearLibraryBtn');
    this.recs = [];
    this.urls = [];
    this.blobCache = {};
    this.list.addEventListener('click', this._onClick.bind(this));
    if (this.clearBtn) this.clearBtn.addEventListener('click', this._clearAll.bind(this));
  }

  Library.prototype.refresh = function () {
    var self = this;
    return AVR.store.available().then(function (ok) {
      if (!ok) {
        self.root.classList.add('unavailable');
        self.empty.hidden = false;
        self.empty.textContent = 'This browser is not letting the app save recordings (private browsing can do this). Recording still works: download each one before you leave the page.';
        self.list.innerHTML = '';
        if (self.clearBtn) self.clearBtn.hidden = true;
        return;
      }
      return AVR.store.listRecordings().then(function (recs) {
        self.recs = recs.filter(function (r) { return r.status === 'complete'; });
        self.render();
        return self.updateStorage();
      });
    }).catch(function () { /* the library is secondary; never break the recorder */ });
  };

  Library.prototype.get = function (id) {
    for (var i = 0; i < this.recs.length; i++) if (this.recs[i].id === id) return this.recs[i];
    return null;
  };

  Library.prototype.updateStorage = function () {
    var el = this.storageEl;
    return AVR.store.estimate().then(function (est) {
      if (!est || !est.quota) {
        el.hidden = true;
        return;
      }
      var pct = Math.min(100, (est.usage / est.quota) * 100);
      el.hidden = false;
      el.innerHTML = '<span class="storage-text"></span><span class="storage-bar"><span class="storage-fill"></span></span>';
      el.querySelector('.storage-text').textContent = AVR.formatBytes(est.usage) + ' used · ' + AVR.formatBytes(Math.max(0, est.quota - est.usage)) + ' free';
      var fill = el.querySelector('.storage-fill');
      fill.style.width = Math.max(1, pct).toFixed(1) + '%';
      fill.classList.toggle('warn', pct > 80);
    });
  };

  Library.prototype.render = function () {
    var self = this;
    this.urls.forEach(function (u) { URL.revokeObjectURL(u); });
    this.urls = [];
    this.list.innerHTML = '';
    this.empty.hidden = this.recs.length > 0;
    if (this.clearBtn) this.clearBtn.hidden = this.recs.length < 2;
    if (!this.recs.length) {
      this.empty.textContent = 'Nothing here yet. Your recordings are saved here automatically as you record.';
    }
    var canShare = AVR.platform.canShareFiles;

    this.recs.forEach(function (rec) {
      var li = document.createElement('li');
      li.className = 'rec-card';
      li.dataset.id = rec.id;
      var isAudio = rec.kind === 'audio';
      var fmt = (rec.ext || 'webm').toUpperCase();
      var badges = '';
      if (rec.recovered) badges += '<span class="badge badge-warn" title="Recovered after the page closed unexpectedly">Recovered</span>';
      if (rec.incomplete) badges += '<span class="badge badge-danger" title="Storage ran out while saving; part of this recording may be missing">Partial</span>';

      li.innerHTML =
        '<button type="button" class="rec-thumb" data-action="play" aria-label="Play">' +
          '<span class="rec-thumb-icon">' + AVR.icon(MODE_ICONS[rec.mode] || 'film-strip') + '</span>' +
          '<span class="rec-play">' + AVR.icon('play-fill') + '</span>' +
          '<span class="rec-duration">' + AVR.formatDuration(rec.durationMs) + '</span>' +
        '</button>' +
        '<div class="rec-body">' +
          '<div class="rec-title"><div class="rec-name"></div>' +
            '<button type="button" class="btn btn-sm btn-ghost btn-icon-only" data-action="rename" aria-label="Rename" title="Rename">' + AVR.icon('pencil-simple') + '</button>' +
            '<button type="button" class="btn btn-sm btn-ghost btn-icon-only btn-danger-ghost" data-action="delete" aria-label="Delete" title="Delete">' + AVR.icon('trash') + '</button>' +
          '</div>' +
          '<div class="rec-meta">' + AVR.escapeHtml(AVR.formatDate(rec.createdAt)) + ' · ' + AVR.formatBytes(rec.size) + ' · ' + fmt +
            (rec.width && !isAudio ? ' · ' + rec.width + '×' + rec.height : '') + ' ' + badges + '</div>' +
          '<div class="rec-actions">' +
            '<button type="button" class="btn btn-sm btn-success" data-action="download">' + AVR.icon('download-simple') + '<span>Download</span></button>' +
            (canShare ? '<button type="button" class="btn btn-sm btn-secondary" data-action="share">' + AVR.icon('share-network') + '<span>Share</span></button>' : '') +
            '<button type="button" class="btn btn-sm btn-secondary" data-action="wav" title="Save the sound as a WAV file for editing">' + AVR.icon('file-audio') + '<span>WAV</span></button>' +
          '</div>' +
        '</div>';
      var nameEl = li.querySelector('.rec-name');
      nameEl.textContent = rec.name;
      nameEl.title = rec.name;
      li.querySelector('.rec-thumb').setAttribute('aria-label', 'Play ' + rec.name);

      if (rec.thumb) {
        var url = URL.createObjectURL(rec.thumb);
        self.urls.push(url);
        var img = document.createElement('img');
        img.alt = '';
        img.src = url;
        img.loading = 'lazy';
        li.querySelector('.rec-thumb').insertBefore(img, li.querySelector('.rec-thumb').firstChild);
      }
      self.list.appendChild(li);
    });
  };

  Library.prototype.loadBlob = function (rec) {
    var cached = this.blobCache[rec.id];
    if (cached) return Promise.resolve(cached);
    var self = this;
    return AVR.RecordingSession.loadBlob(rec).then(function (blob) {
      self.blobCache[rec.id] = blob;
      return blob;
    });
  };

  Library.prototype.fileName = function (rec, ext) {
    return AVR.safeFilename(rec.name) + '.' + (ext || rec.ext || 'webm');
  };

  Library.prototype._onClick = function (e) {
    var btn = e.target.closest ? e.target.closest('[data-action]') : null;
    if (!btn) return;
    var card = btn.closest('.rec-card');
    var rec = card && this.get(card.dataset.id);
    if (!rec) return;
    var action = btn.getAttribute('data-action');
    var self = this;

    if (action === 'play') {
      if (this.handlers.onPlay) this.handlers.onPlay(rec);
    } else if (action === 'download') {
      this.loadBlob(rec).then(function (blob) {
        AVR.downloadBlob(blob, self.fileName(rec));
      }).catch(function (err) { AVR.toast(err.message, 'error'); });
    } else if (action === 'share') {
      this.share(rec);
    } else if (action === 'wav') {
      this.exportWav(rec, btn);
    } else if (action === 'rename') {
      var name = window.prompt('Rename recording', rec.name);
      if (name && name.trim() && name.trim() !== rec.name) {
        AVR.store.updateRecording(rec.id, { name: name.trim().slice(0, 120) }).then(function () {
          if (self.handlers.onRenamed) self.handlers.onRenamed(rec.id, name.trim());
          return self.refresh();
        });
      }
    } else if (action === 'delete') {
      if (window.confirm('Delete "' + rec.name + '"? This cannot be undone.')) this.remove(rec.id);
    }
  };

  Library.prototype.share = function (rec) {
    var self = this;
    var fileName = this.fileName(rec);
    return this.loadBlob(rec).then(function (blob) {
      if (!AVR.canShareFile(blob, fileName)) {
        AVR.toast('This device cannot share this file. Use Download instead.', 'warning');
        return;
      }
      return AVR.shareFile(blob, fileName, rec.name).catch(function (err) {
        if (err && err.name === 'AbortError') return;
        // Safari needs the share to start straight from the tap; the file is
        // cached now, so a second tap works.
        if (err && err.name === 'NotAllowedError') AVR.toast('Tap Share again to open the share sheet.', 'info');
        else AVR.toast('Sharing failed: ' + (err && err.message ? err.message : 'unknown error'), 'error');
      });
    }).catch(function (err) {
      AVR.toast(err.message, 'error');
      self.refresh();
    });
  };

  Library.prototype.exportWav = function (rec, btn) {
    var self = this;
    if (rec.durationMs > 45 * 60 * 1000 && !window.confirm('This recording is long. Converting it to WAV needs a lot of memory and may fail on phones. Continue?')) return;
    if (btn) { btn.disabled = true; btn.classList.add('busy'); }
    return this.loadBlob(rec).then(function (blob) {
      return AVR.wav.fromBlob(blob);
    }).then(function (wav) {
      AVR.downloadBlob(wav, self.fileName(rec, 'wav'));
    }).catch(function () {
      AVR.toast('Could not convert this recording to WAV in this browser.', 'error');
    }).then(function () {
      if (btn) { btn.disabled = false; btn.classList.remove('busy'); }
    });
  };

  Library.prototype.remove = function (id) {
    var self = this;
    delete this.blobCache[id];
    return AVR.store.deleteRecording(id).then(function () {
      if (self.handlers.onDeleted) self.handlers.onDeleted(id);
      return self.refresh();
    }).catch(function () {
      AVR.toast('Could not delete the recording.', 'error');
    });
  };

  Library.prototype._clearAll = function () {
    var self = this;
    if (!window.confirm('Delete all ' + this.recs.length + ' recordings from this browser? Download any you want to keep first. This cannot be undone.')) return;
    var ids = this.recs.map(function (r) { return r.id; });
    Promise.all(ids.map(function (id) {
      delete self.blobCache[id];
      return AVR.store.deleteRecording(id).then(function () {
        if (self.handlers.onDeleted) self.handlers.onDeleted(id);
      });
    })).catch(function () {}).then(function () { return self.refresh(); });
  };

  AVR.Library = Library;
})(window.AVR = window.AVR || {});
