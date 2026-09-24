// On-device storage for recordings, in IndexedDB.
//
// Each recording is written to disk one chunk (about a second of media) at a
// time while it is being captured. That is what makes recording crash-safe: if
// the tab is closed, the browser crashes or the battery dies, everything up to
// the last second is already on disk and is recovered on the next visit. It also
// keeps long recordings out of memory, which matters on phones.
//
// If IndexedDB is unavailable (some private-browsing modes) every method fails
// soft and the recorder falls back to keeping chunks in memory.
(function (AVR) {
  'use strict';

  var DB_NAME = 'av-recorder';
  var DB_VERSION = 1;
  var dbPromise = null;

  function request(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function done(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
      tx.onabort = function () { reject(tx.error || new Error('Storage transaction aborted')); };
    });
  }

  function chunkRange(recId) {
    return IDBKeyRange.bound([recId, 0], [recId, Infinity]);
  }

  function openDb() {
    return new Promise(function (resolve) {
      if (!window.indexedDB) return resolve(null);
      var settled = false;
      function finish(db) { if (!settled) { settled = true; resolve(db); } }
      var req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        return finish(null);
      }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('recordings')) db.createObjectStore('recordings', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: ['recId', 'seq'] });
      };
      req.onsuccess = function () {
        var db = req.result;
        db.onversionchange = function () { db.close(); };
        finish(db);
      };
      req.onerror = function () { finish(null); };
      // A stuck open (seen in some private modes) must not stall the app.
      setTimeout(function () { finish(null); }, 4000);
    });
  }

  // Older Safari versions open IndexedDB fine but refuse to store Blobs, so
  // prove a Blob round-trips before relying on it.
  function probe(db) {
    try {
      var tx = db.transaction('chunks', 'readwrite');
      var store = tx.objectStore('chunks');
      store.put({ recId: '__probe__', seq: 0, blob: new Blob(['ok'], { type: 'text/plain' }) });
      store.delete(['__probe__', 0]);
      return done(tx).then(function () { return db; }, function () { return null; });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  function db() {
    if (!dbPromise) {
      dbPromise = openDb().then(function (d) { return d ? probe(d) : null; }).catch(function () { return null; });
    }
    return dbPromise;
  }

  function withDb(fn, fallback) {
    return db().then(function (d) {
      if (!d) {
        if (fallback !== undefined) return fallback;
        throw new Error('Storage is unavailable');
      }
      return fn(d);
    });
  }

  var Store = {
    available: function () {
      return db().then(function (d) { return !!d; });
    },

    putRecording: function (rec) {
      return withDb(function (d) {
        var tx = d.transaction('recordings', 'readwrite');
        tx.objectStore('recordings').put(rec);
        return done(tx);
      });
    },

    updateRecording: function (id, patch) {
      return withDb(function (d) {
        var tx = d.transaction('recordings', 'readwrite');
        var store = tx.objectStore('recordings');
        var result = null;
        // Plain callbacks, not promises: older Safari commits a transaction
        // before promise callbacks run.
        var get = store.get(id);
        get.onsuccess = function () {
          var rec = get.result;
          if (!rec) return;
          Object.keys(patch).forEach(function (k) { rec[k] = patch[k]; });
          result = rec;
          store.put(rec);
        };
        return done(tx).then(function () { return result; });
      });
    },

    // Writes one chunk and the recording's running totals atomically, so the
    // metadata never claims more media than is actually on disk.
    appendChunk: function (recId, seq, blob, patch) {
      return withDb(function (d) {
        var tx = d.transaction(['chunks', 'recordings'], 'readwrite');
        tx.objectStore('chunks').put({ recId: recId, seq: seq, blob: blob });
        if (patch) {
          var recs = tx.objectStore('recordings');
          var get = recs.get(recId);
          get.onsuccess = function () {
            var rec = get.result;
            if (!rec) return;
            Object.keys(patch).forEach(function (k) { rec[k] = patch[k]; });
            recs.put(rec);
          };
        }
        return done(tx);
      });
    },

    putChunk: function (recId, seq, blob) {
      return withDb(function (d) {
        var tx = d.transaction('chunks', 'readwrite');
        tx.objectStore('chunks').put({ recId: recId, seq: seq, blob: blob });
        return done(tx);
      });
    },

    // Returns [{seq, blob}] in recording order.
    getChunks: function (recId) {
      return withDb(function (d) {
        var store = d.transaction('chunks', 'readonly').objectStore('chunks');
        var range = chunkRange(recId);
        if (store.getAll) {
          return request(store.getAll(range)).then(function (rows) {
            return rows.map(function (r) { return { seq: r.seq, blob: r.blob }; });
          });
        }
        return new Promise(function (resolve, reject) {
          var rows = [];
          var cur = store.openCursor(range);
          cur.onsuccess = function () {
            var c = cur.result;
            if (!c) return resolve(rows);
            rows.push({ seq: c.value.seq, blob: c.value.blob });
            c.continue();
          };
          cur.onerror = function () { reject(cur.error); };
        });
      }, []);
    },

    getRecording: function (id) {
      return withDb(function (d) {
        return request(d.transaction('recordings', 'readonly').objectStore('recordings').get(id));
      }, null);
    },

    listRecordings: function () {
      return withDb(function (d) {
        return request(d.transaction('recordings', 'readonly').objectStore('recordings').getAll()).then(function (rows) {
          return rows.sort(function (a, b) { return b.createdAt - a.createdAt; });
        });
      }, []);
    },

    deleteRecording: function (id) {
      return withDb(function (d) {
        var tx = d.transaction(['chunks', 'recordings'], 'readwrite');
        tx.objectStore('recordings').delete(id);
        tx.objectStore('chunks').delete(chunkRange(id));
        return done(tx);
      });
    },

    estimate: function () {
      if (!navigator.storage || !navigator.storage.estimate) return Promise.resolve(null);
      return navigator.storage.estimate().catch(function () { return null; });
    },

    // {available, usage, quota, persisted}: one call for everything the UI
    // and the diagnostics report need to know about storage.
    status: function () {
      var persisted = navigator.storage && navigator.storage.persisted
        ? navigator.storage.persisted().catch(function () { return false; })
        : Promise.resolve(false);
      return Promise.all([Store.available(), Store.estimate(), persisted]).then(function (r) {
        return {
          available: r[0],
          usage: (r[1] && r[1].usage) || 0,
          quota: (r[1] && r[1].quota) || 0,
          persisted: !!r[2],
        };
      });
    },

    // Asks the browser not to evict recordings under storage pressure. Chrome
    // decides silently; Firefox may show a prompt, so it is asked once a
    // recording has been saved, not while one is starting.
    persist: function () {
      if (!navigator.storage || !navigator.storage.persist) return Promise.resolve(false);
      return navigator.storage.persisted()
        .then(function (already) { return already || navigator.storage.persist(); })
        .catch(function () { return false; });
    },
  };

  AVR.store = Store;
})(window.AVR = window.AVR || {});
