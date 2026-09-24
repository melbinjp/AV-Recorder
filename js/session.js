// One recording: wraps MediaRecorder, streams each chunk to on-device storage as
// it arrives, keeps accurate time across pauses, and finalizes a playable file.
(function (AVR) {
  'use strict';

  var TIMESLICE = 1000; // ms of media per chunk, and so the most a crash can lose
  var LOCK_PREFIX = 'avr-rec-';
  var MB = 1024 * 1024;
  // If device storage fails mid-recording, chunks are kept in memory instead.
  // Past this much the tab risks being killed for memory, taking the recording
  // with it, so the app stops and saves first. Phones get far less headroom.

  function log(level, event, detail) {
    if (AVR.log) AVR.log(level, event, detail);
  }

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
    if (opts.videoBitsPerSecond) {
      bitrates.videoBitsPerSecond = opts.videoBitsPerSecond;
      // A keyframe every 2 s (Chrome 126+; ignored elsewhere): quick seeking in
      // players and editors for a small size cost. YouTube recommends 2 s.
      bitrates.videoKeyFrameIntervalDuration = 2000;
    }
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
    this.pending = {}; // seq → blob whose write to storage isn't confirmed yet
    this.memBytes = 0;
    this.headBlobs = {}; // seq → original chunk, for the file's first HEAD_BYTES
    this.headBytes = 0;
    this.limitHit = false;
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
    this.onlimit = null;
  }

  RecordingSession.TIMESLICE = TIMESLICE;
  RecordingSession.memoryBudget = AVR.platform && AVR.platform.isMobile ? 300 * MB : 2048 * MB;
  // Longest the save path waits on browser storage before carrying on.
  RecordingSession.storageWait = 20000;

  RecordingSession.prototype.elapsed = function () {
    return this.activeMs + (this.state === 'recording' ? now() - this.resumedAt : 0);
  };

  // Measured bytes per second of recording, once there is enough to measure.
  RecordingSession.prototype.byteRate = function () {
    var ms = this.elapsed();
    return ms > 5000 && this.bytes > 0 ? this.bytes / (ms / 1000) : 0;
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

    this.startPromise = AVR.store.available().then(function (ok) {
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
      log('info', 'record-start', {
        mode: o.mode,
        mime: rec.mimeType || self.mimeType || 'default',
        video: o.videoBitsPerSecond || 0,
        audio: o.audioBitsPerSecond || 0,
        size: (o.width || 0) + 'x' + (o.height || 0),
        stored: self.persist,
      });
    });
    return this.startPromise;
  };

  RecordingSession.prototype._onData = function (blob) {
    if (!blob || !blob.size) return;
    var self = this;
    var seq = this.seq++;
    this.bytes += blob.size;
    if (blob.type && (!this.mimeType || this.mimeType.indexOf('/') === -1)) this.mimeType = blob.type;
    // Keep the chunks holding the start of the file (about a second of media):
    // the header lives there, possibly spread over several chunks, and it is
    // patched from these originals rather than read back from storage.
    if (this.headBytes < AVR.webm.HEAD_BYTES) {
      this.headBlobs[seq] = blob;
      this.headBytes += blob.size;
    }

    if (!this.persist || this.storageFailed) {
      this._keepInMemory(seq, blob);
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
    // Held in memory until storage confirms it, so a slow or stalled write
    // can never drop it from the finished file.
    this.pending[seq] = blob;
    this.writeChain = this.writeChain.then(function () {
      return AVR.store.appendChunk(self.id, seq, blob, patch);
    }).then(function () {
      delete self.pending[seq];
    }, function (err) {
      delete self.pending[seq];
      // Usually a full disk. Keep recording into memory rather than stop.
      if (!self.storageFailed) {
        self.storageFailed = true;
        log('error', 'storage-write-failed', err);
        if (self.onwarning) {
          self.onwarning('Device storage is full. Recording continues in memory. Download it as soon as you stop.');
        }
      }
      self._keepInMemory(seq, blob);
    });
  };

  RecordingSession.prototype._keepInMemory = function (seq, blob) {
    this.memChunks.push({ seq: seq, blob: blob });
    this.memBytes += blob.size;
    if (!this.limitHit && this.memBytes > RecordingSession.memoryBudget) {
      this.limitHit = true;
      log('error', 'memory-limit', AVR.formatBytes(this.memBytes));
      if (this.onlimit) this.onlimit();
    }
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

    // Let a start that is still setting up storage finish first, so stop and
    // start never interleave. (The start sees stopPromise and won't record.)
    var started = this.startPromise ? this.startPromise.catch(function () {}) : Promise.resolve();
    this.stopPromise = started.then(function () {
      return new Promise(function (resolve) {
        var rec = self.recorder;
        if (!rec || rec.state === 'inactive') return resolve();
        var settled = false;
        var finish = function () { if (!settled) { settled = true; resolve(); } };
        rec.addEventListener('stop', finish);
        try {
          rec.stop();
        } catch (e) {
          finish();
        }
        // Some browsers never fire "stop" after an encoder error.
        setTimeout(finish, 8000);
      });
    }).then(function () {
      // The final chunk arrives before "stop"; wait for it to reach storage,
      // but not forever: anything unconfirmed is still held in memory.
      return AVR.withTimeout(self.writeChain, RecordingSession.storageWait, 'timeout').then(function (r) {
        if (r === 'timeout') log('warn', 'storage-slow', Object.keys(self.pending).length + ' chunk(s) unconfirmed');
      });
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
    var self = this;
    var mem = this.memChunks.slice();
    var fromDisk = this.persist
      ? AVR.withTimeout(AVR.store.getChunks(this.id).catch(function () { return []; }), RecordingSession.storageWait, null)
      : Promise.resolve([]);
    return fromDisk.then(function (disk) {
      if (disk === null) {
        log('error', 'storage-unresponsive', 'reading chunks');
        throw new Error('Saving is taking too long because this browser\'s storage is not responding. ' +
          'The recording is safe: it will appear in Your recordings the next time you open the app.');
      }
      var bySeq = {};
      disk.forEach(function (c) { bySeq[c.seq] = c; });
      Object.keys(self.pending).forEach(function (k) { bySeq[k] = { seq: Number(k), blob: self.pending[k] }; });
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
      if (!chunks.length) {
        // Stopped before the encoder produced anything (a fraction of a second).
        log('info', 'record-empty', { ms: durationMs });
        if (self.persist) AVR.store.deleteRecording(self.id).catch(function () {});
        var empty = new Error('Nothing was recorded.');
        empty.code = 'empty';
        throw empty;
      }
      var isWebm = /webm/i.test(type);
      var blobs = chunks.map(function (c) { return self.headBlobs[c.seq] || c.blob; });
      var fixing = isWebm ? AVR.webm.fixDurationInChunks(blobs, durationMs) : Promise.resolve(null);
      return fixing.then(function (fixed) {
        if (isWebm && !fixed) log('warn', 'webm-duration-not-set', { firstChunks: blobs.slice(0, 3).map(function (b) { return b.size; }) });
        var changed = fixed ? fixed.changed : [];
        if (fixed) blobs = fixed.blobs;
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

        var writes = changed.map(function (i) { return AVR.store.putChunk(self.id, chunks[i].seq, blobs[i]); });
        self.memChunks.forEach(function (c) { writes.push(AVR.store.putChunk(self.id, c.seq, c.blob)); });
        Object.keys(self.pending).forEach(function (k) { writes.push(AVR.store.putChunk(self.id, Number(k), self.pending[k])); });
        // The file itself is ready in memory; storage bookkeeping gets a time
        // limit so a stalled browser store can't hold the person hostage.
        return AVR.withTimeout(Promise.all(writes).then(function () {
          return true;
        }, function () {
          return false;
        }), RecordingSession.storageWait, 'timeout').then(function (complete) {
          if (complete === 'timeout') {
            log('warn', 'storage-slow', 'finalizing');
            complete = true; // writes are queued; recovery completes them on the next visit
          }
          return AVR.withTimeout(AVR.store.updateRecording(self.id, {
            status: 'complete',
            incomplete: !complete,
            durationMs: durationMs,
            size: blob.size,
            mimeType: type,
            ext: ext,
            chunkCount: chunks.length,
            updatedAt: Date.now(),
          }), RecordingSession.storageWait, null).then(function () {
            result.saved = complete;
            log(complete ? 'info' : 'error', complete ? 'record-saved' : 'record-partly-saved',
              { ms: durationMs, bytes: blob.size, chunks: chunks.length, type: type });
            return result;
          }, function (err) {
            log('error', 'record-save-failed', err);
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
    log('warn', 'recovering', { id: rec.id, ms: rec.durationMs, bytes: rec.size });
    return AVR.store.getChunks(rec.id).then(function (chunks) {
      if (!chunks.length) return AVR.store.deleteRecording(rec.id).then(function () { return null; });
      var size = 0;
      chunks.forEach(function (c) { size += c.blob.size; });
      var duration = rec.durationMs || chunks.length * TIMESLICE;
      var blobs = chunks.map(function (c) { return c.blob; });
      var fixing = /webm/i.test(rec.mimeType || '') ? AVR.webm.fixDurationInChunks(blobs, duration) : Promise.resolve(null);
      return fixing.then(function (fixed) {
        if (!fixed) return null;
        return Promise.all(fixed.changed.map(function (i) {
          return AVR.store.putChunk(rec.id, chunks[i].seq, fixed.blobs[i]);
        }));
      }).then(function () {
        return AVR.store.updateRecording(rec.id, {
          status: 'complete',
          recovered: true,
          size: size,
          durationMs: duration,
          chunkCount: chunks.length,
        });
      });
    }).catch(function (err) {
      log('error', 'recover-failed', err);
      return null;
    });
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
