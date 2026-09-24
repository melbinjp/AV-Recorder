// One recording: wraps MediaRecorder, streams each chunk to on-device storage as
// it arrives, keeps accurate time across pauses, and finalizes a playable file.
(function (AVR) {
  'use strict';

  var TIMESLICE = 1000; // ms of media per chunk, and so the most a crash can lose
  var LOCK_PREFIX = 'avr-rec-';

  function uid() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function now() {
    return window.performance && performance.now ? performance.now() : Date.now();
  }

  // Tries the preferred settings first, then progressively simpler ones, so an
  // unusual browser still records something rather than refusing outright.
  function createRecorder(stream, opts) {
    var attempts = [];
    var mime = opts.format && opts.format.mime;
    var bitrates = {};
    if (opts.videoBitsPerSecond) bitrates.videoBitsPerSecond = opts.videoBitsPerSecond;
    if (opts.audioBitsPerSecond) bitrates.audioBitsPerSecond = opts.audioBitsPerSecond;
    if (mime) {
      attempts.push(Object.assign({ mimeType: mime }, bitrates));
      attempts.push({ mimeType: mime });
    }
    attempts.push(bitrates);
    attempts.push(undefined);
    var lastErr;
    for (var i = 0; i < attempts.length; i++) {
      try {
        return attempts[i] ? new MediaRecorder(stream, attempts[i]) : new MediaRecorder(stream);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('This browser cannot record this stream.');
  }

  function RecordingSession(opts) {
    this.opts = opts;
    this.id = uid();
    this.kind = opts.kind;
    this.stream = opts.stream;
    this.recorder = null;
    this.mimeType = '';
    this.seq = 0;
    this.bytes = 0;
    this.memChunks = [];
    this.persist = false;
    this.storageFailed = false;
    this.writeChain = Promise.resolve();
    this.activeMs = 0;
    this.resumedAt = 0;
    this.state = 'inactive'; // inactive | recording | paused | stopping | done
    this.stopPromise = null;
    this.releaseLock = null;
    this.onerror = null;
    this.onwarning = null;
  }

  RecordingSession.TIMESLICE = TIMESLICE;

  RecordingSession.prototype.elapsed = function () {
    return this.activeMs + (this.state === 'recording' ? now() - this.resumedAt : 0);
  };

  RecordingSession.prototype.start = function () {
    var self = this;
    var o = this.opts;
    var rec;
    try {
      rec = createRecorder(this.stream, o);
    } catch (e) {
      return Promise.reject(e);
    }
    this.recorder = rec;
    this.mimeType = rec.mimeType || (o.format && o.format.mime) || '';

    return AVR.store.available().then(function (ok) {
      if (!ok) return;
      self.record = {
        id: self.id,
        name: o.name,
        mode: o.mode,
        kind: o.kind,
        mimeType: AVR.formats.baseType(self.mimeType, o.kind),
        ext: AVR.formats.extFor(self.mimeType, o.kind),
        width: o.width || 0,
        height: o.height || 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        durationMs: 0,
        size: 0,
        chunkCount: 0,
        status: 'recording',
        thumb: null,
      };
      return AVR.store.putRecording(self.record).then(function () {
        self.persist = true;
      }, function () {
        self.persist = false;
      });
    }).then(function () {
      // Stopped while storage was being prepared: never start at all.
      if (self.stopPromise) return;
      rec.ondataavailable = function (e) { self._onData(e.data); };
      rec.onerror = function (e) {
        var err = (e && e.error) || e;
        if (self.onerror) self.onerror(err);
      };
      rec.start(TIMESLICE);
      self.state = 'recording';
      self.resumedAt = now();
      self._lock();
    });
  };

  RecordingSession.prototype._onData = function (blob) {
    if (!blob || !blob.size) return;
    var self = this;
    var seq = this.seq++;
    this.bytes += blob.size;
    if (blob.type && (!this.mimeType || this.mimeType.indexOf('/') === -1)) this.mimeType = blob.type;

    if (!this.persist || this.storageFailed) {
      this.memChunks.push({ seq: seq, blob: blob });
      return;
    }
    var patch = {
      size: this.bytes,
      durationMs: Math.round(this.elapsed()),
      chunkCount: this.seq,
      updatedAt: Date.now(),
      mimeType: AVR.formats.baseType(this.mimeType, this.kind),
      ext: AVR.formats.extFor(this.mimeType, this.kind),
    };
    this.writeChain = this.writeChain.then(function () {
      return AVR.store.appendChunk(self.id, seq, blob, patch);
    }).catch(function () {
      // Usually a full disk. Keep recording into memory rather than stop.
      self.memChunks.push({ seq: seq, blob: blob });
      if (!self.storageFailed) {
        self.storageFailed = true;
        if (self.onwarning) {
          self.onwarning('Device storage is full. Recording continues in memory. Download it as soon as you stop.');
        }
      }
    });
  };

  RecordingSession.prototype.pause = function () {
    var rec = this.recorder;
    if (!rec || this.state !== 'recording' || rec.state !== 'recording') return false;
    // Flush what we have so a crash while paused loses nothing.
    try { rec.requestData(); } catch (e) { /* optional */ }
    try {
      rec.pause();
    } catch (e) {
      return false;
    }
    this.activeMs += now() - this.resumedAt;
    this.state = 'paused';
    return true;
  };

  RecordingSession.prototype.resume = function () {
    var rec = this.recorder;
    if (!rec || this.state !== 'paused' || rec.state !== 'paused') return false;
    try {
      rec.resume();
    } catch (e) {
      return false;
    }
    this.resumedAt = now();
    this.state = 'recording';
    return true;
  };

  RecordingSession.prototype.setThumbnail = function (blob) {
    if (!blob || !this.persist) return Promise.resolve();
    return AVR.store.updateRecording(this.id, { thumb: blob }).catch(function () {});
  };

  // Stops recording and resolves with the finished file:
  // {id, blob, name, durationMs, mimeType, ext, saved}
  RecordingSession.prototype.stop = function () {
    if (this.stopPromise) return this.stopPromise;
    var self = this;
    if (this.state === 'recording') this.activeMs += now() - this.resumedAt;
    this.state = 'stopping';

    this.stopPromise = new Promise(function (resolve) {
      var rec = self.recorder;
      if (!rec || rec.state === 'inactive') return resolve();
      var settled = false;
      function finish() { if (!settled) { settled = true; resolve(); } }
      rec.addEventListener('stop', finish);
      try {
        rec.stop();
      } catch (e) {
        finish();
      }
      // Some browsers never fire "stop" after an encoder error.
      setTimeout(finish, 8000);
    }).then(function () {
      // The final chunk arrives before "stop"; wait for it to reach storage.
      return self.writeChain;
    }).then(function () {
      return self._finalize();
    }).then(function (result) {
      self.state = 'done';
      self._unlock();
      return result;
    }, function (err) {
      self.state = 'done';
      self._unlock();
      throw err;
    });
    return this.stopPromise;
  };

  RecordingSession.prototype._collect = function () {
    var mem = this.memChunks.slice();
    var fromDisk = this.persist ? AVR.store.getChunks(this.id).catch(function () { return []; }) : Promise.resolve([]);
    return fromDisk.then(function (disk) {
      var bySeq = {};
      disk.forEach(function (c) { bySeq[c.seq] = c; });
      mem.forEach(function (c) { bySeq[c.seq] = c; });
      return Object.keys(bySeq).map(Number).sort(function (a, b) { return a - b; }).map(function (k) { return bySeq[k]; });
    });
  };

  RecordingSession.prototype._finalize = function () {
    var self = this;
    var durationMs = Math.round(this.activeMs);
    var type = AVR.formats.baseType(this.mimeType, this.kind);
    var ext = AVR.formats.extFor(this.mimeType, this.kind);

    return this._collect().then(function (chunks) {
      if (!chunks.length) throw new Error('Nothing was recorded. The source may have stopped before recording began.');
      var first = chunks[0];
      var fixing = /webm/i.test(type) ? AVR.webm.fixDuration(first.blob, durationMs) : Promise.resolve(first.blob);
      return fixing.then(function (fixedFirst) {
        var blobs = chunks.map(function (c) { return c.blob; });
        blobs[0] = fixedFirst;
        var blob = new Blob(blobs, { type: type });
        var result = {
          id: self.id,
          blob: blob,
          name: self.opts.name,
          mode: self.opts.mode,
          kind: self.kind,
          durationMs: durationMs,
          mimeType: type,
          ext: ext,
          saved: false,
        };
        if (!self.persist) return result;

        var writes = [];
        if (fixedFirst !== first.blob) writes.push(AVR.store.putChunk(self.id, first.seq, fixedFirst));
        self.memChunks.forEach(function (c) { writes.push(AVR.store.putChunk(self.id, c.seq, c.blob)); });
        return Promise.all(writes).then(function () {
          return true;
        }, function () {
          return false;
        }).then(function (complete) {
          return AVR.store.updateRecording(self.id, {
            status: 'complete',
            incomplete: !complete,
            durationMs: durationMs,
            size: blob.size,
            mimeType: type,
            ext: ext,
            chunkCount: chunks.length,
            updatedAt: Date.now(),
          }).then(function () {
            result.saved = complete;
            return result;
          }, function () {
            return result;
          });
        });
      });
    });
  };

  // Web Locks tell a fresh page whether a recording is still live in another
  // tab, so recovery never touches a recording that is still in progress.
  RecordingSession.prototype._lock = function () {
    var self = this;
    if (!navigator.locks || !navigator.locks.request) return;
    try {
      navigator.locks.request(LOCK_PREFIX + this.id, function () {
        return new Promise(function (release) { self.releaseLock = release; });
      }).catch(function () {});
    } catch (e) { /* locks are an optimisation */ }
  };

  RecordingSession.prototype._unlock = function () {
    if (this.releaseLock) this.releaseLock();
    this.releaseLock = null;
  };

  function heldLocks() {
    if (!navigator.locks || !navigator.locks.query) return Promise.resolve(null);
    return navigator.locks.query().then(function (snap) {
      var held = {};
      (snap.held || []).concat(snap.pending || []).forEach(function (l) { held[l.name] = true; });
      return held;
    }).catch(function () { return null; });
  }

  function recoverOne(rec) {
    return AVR.store.getChunks(rec.id).then(function (chunks) {
      if (!chunks.length) return AVR.store.deleteRecording(rec.id).then(function () { return null; });
      var size = 0;
      chunks.forEach(function (c) { size += c.blob.size; });
      var duration = rec.durationMs || chunks.length * TIMESLICE;
      var first = chunks[0];
      var fixing = /webm/i.test(rec.mimeType || '') ? AVR.webm.fixDuration(first.blob, duration) : Promise.resolve(first.blob);
      return fixing.then(function (fixed) {
        return fixed !== first.blob ? AVR.store.putChunk(rec.id, first.seq, fixed) : null;
      }).then(function () {
        return AVR.store.updateRecording(rec.id, {
          status: 'complete',
          recovered: true,
          size: size,
          durationMs: duration,
          chunkCount: chunks.length,
        });
      });
    }).catch(function () { return null; });
  }

  // Finalizes recordings left unfinished by a crash, closed tab or dead battery.
  // Resolves with the recovered recordings.
  RecordingSession.recoverAll = function () {
    return AVR.store.listRecordings().then(function (recs) {
      var pending = recs.filter(function (r) { return r.status === 'recording'; });
      if (!pending.length) return [];
      return heldLocks().then(function (held) {
        var stale = pending.filter(function (r) {
          if (held) return !held[LOCK_PREFIX + r.id];
          // No Web Locks: only touch recordings silent for over a minute.
          return Date.now() - (r.updatedAt || r.createdAt) > 60000;
        });
        return Promise.all(stale.map(recoverOne));
      }).then(function (list) {
        return list.filter(Boolean);
      });
    }).catch(function () { return []; });
  };

  // Rebuilds a stored recording as one Blob.
  RecordingSession.loadBlob = function (rec) {
    return AVR.store.getChunks(rec.id).then(function (chunks) {
      if (!chunks.length) throw new Error('This recording has no data left in storage.');
      return new Blob(chunks.map(function (c) { return c.blob; }), { type: rec.mimeType || 'video/webm' });
    });
  };

  AVR.RecordingSession = RecordingSession;
})(window.AVR = window.AVR || {});
