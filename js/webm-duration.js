// Writes the missing Duration into WebM files produced by MediaRecorder.
//
// Browsers write WebM as a live stream, with no Duration in the header. Players
// then show the length as unknown, the seek bar does not work, and some editors
// refuse the file. This patches the header's Segment > Info element with the
// real duration, touching only the first few hundred bytes of the file.
//
// WebM is EBML: every element is [ID][size][data], where ID and size are
// variable-length integers whose length is given by the leading zero bits of the
// first byte.
(function (AVR) {
  'use strict';

  var ID_EBML = 0x1a45dfa3;
  var ID_SEGMENT = 0x18538067;
  var ID_INFO = 0x1549a966;
  var ID_TIMECODE_SCALE = 0x2ad7b1;
  var ID_DURATION = 0x4489;
  var ID_CLUSTER = 0x1f43b675;
  var ID_SEEK_HEAD = 0x114d9b74;

  var HEAD_BYTES = 256 * 1024;

  // Reads a variable-length integer. IDs keep their length-marker bit; sizes do not.
  function readVint(bytes, pos, isId) {
    if (pos >= bytes.length) return null;
    var first = bytes[pos];
    if (first === 0) return null;
    var len = 1;
    var mask = 0x80;
    while (!(first & mask)) {
      len++;
      mask >>= 1;
    }
    if (len > (isId ? 4 : 8) || pos + len > bytes.length) return null;
    var value = isId ? first : first & (mask - 1);
    var allOnes = (first & (mask - 1)) === mask - 1;
    for (var i = 1; i < len; i++) {
      value = value * 256 + bytes[pos + i];
      if (bytes[pos + i] !== 0xff) allOnes = false;
    }
    return { len: len, value: value, unknown: !isId && allOnes };
  }

  // Encodes an element size, using `minLen` bytes if it fits.
  function encodeSize(value, minLen) {
    var len = Math.max(1, minLen || 1);
    // All-ones is reserved for "unknown size", so the maximum is 2^(7*len) - 2.
    while (len < 8 && value > Math.pow(2, 7 * len) - 2) len++;
    if (value > Math.pow(2, 7 * len) - 2) return null;
    var out = new Uint8Array(len);
    var v = value;
    for (var i = len - 1; i >= 0; i--) {
      out[i] = v % 256;
      v = Math.floor(v / 256);
    }
    out[0] |= 0x80 >> (len - 1);
    return out;
  }

  function readUint(bytes, pos, len) {
    var v = 0;
    for (var i = 0; i < len; i++) v = v * 256 + bytes[pos + i];
    return v;
  }

  function concat(parts) {
    var total = 0;
    parts.forEach(function (p) { total += p.length; });
    var out = new Uint8Array(total);
    var off = 0;
    parts.forEach(function (p) { out.set(p, off); off += p.length; });
    return out;
  }

  // Patches the header bytes. Returns new header bytes, or null if the file is
  // not a layout we can safely patch (in which case the original is kept).
  function patchHead(head, durationMs) {
    var id = readVint(head, 0, true);
    if (!id || id.value !== ID_EBML) return null;
    var size = readVint(head, id.len, false);
    if (!size || size.unknown) return null;
    var pos = id.len + size.len + size.value;

    var segId = readVint(head, pos, true);
    if (!segId || segId.value !== ID_SEGMENT) return null;
    var segSizePos = pos + segId.len;
    var segSize = readVint(head, segSizePos, false);
    if (!segSize) return null;
    var segDataStart = segSizePos + segSize.len;

    var sawSeekHead = false;
    var p = segDataStart;
    while (p < head.length) {
      var elId = readVint(head, p, true);
      if (!elId) return null;
      var elSize = readVint(head, p + elId.len, false);
      if (!elSize) return null;
      var dataStart = p + elId.len + elSize.len;

      if (elId.value === ID_INFO) {
        if (elSize.unknown || dataStart + elSize.value > head.length) return null;
        return patchInfo(head, {
          start: p,
          idLen: elId.len,
          sizeLen: elSize.len,
          dataStart: dataStart,
          end: dataStart + elSize.value,
        }, segSizePos, segSize, sawSeekHead, durationMs);
      }
      if (elId.value === ID_SEEK_HEAD) sawSeekHead = true;
      if (elId.value === ID_CLUSTER || elSize.unknown) return null;
      p = dataStart + elSize.value;
    }
    return null;
  }

  function patchInfo(head, info, segSizePos, segSize, sawSeekHead, durationMs) {
    var scale = 1000000;
    var durationAt = -1;
    var durationLen = 0;

    var p = info.dataStart;
    while (p < info.end) {
      var id = readVint(head, p, true);
      if (!id) return null;
      var size = readVint(head, p + id.len, false);
      if (!size || size.unknown) return null;
      var data = p + id.len + size.len;
      if (id.value === ID_TIMECODE_SCALE && size.value > 0 && size.value <= 8) scale = readUint(head, data, size.value) || scale;
      if (id.value === ID_DURATION && (size.value === 4 || size.value === 8)) {
        durationAt = data;
        durationLen = size.value;
      }
      p = data + size.value;
    }

    var value = (durationMs * 1e6) / scale;

    // Duration already present (possibly zero): overwrite it in place.
    if (durationAt >= 0) {
      var copy = head.slice(0);
      var view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
      if (durationLen === 8) view.setFloat64(durationAt, value, false);
      else view.setFloat32(durationAt, value, false);
      return copy;
    }

    // Inserting bytes would shift the offsets a SeekHead points at. Recorder
    // output never has one, but refuse rather than corrupt a file that does.
    if (sawSeekHead) return null;

    var durationEl = new Uint8Array(11);
    durationEl[0] = 0x44;
    durationEl[1] = 0x89;
    durationEl[2] = 0x88; // size 8
    new DataView(durationEl.buffer).setFloat64(3, value, false);

    var oldDataLen = info.end - info.dataStart;
    var newSize = encodeSize(oldDataLen + durationEl.length, info.sizeLen);
    if (!newSize) return null;
    var newInfo = concat([
      head.subarray(info.start, info.start + info.idLen),
      newSize,
      head.subarray(info.dataStart, info.end),
      durationEl,
    ]);
    var delta = newInfo.length - (info.end - info.start);

    var segSizeBytes = head.subarray(segSizePos, segSizePos + segSize.len);
    if (!segSize.unknown) {
      segSizeBytes = encodeSize(segSize.value + delta, segSize.len);
      if (!segSizeBytes || segSizeBytes.length !== segSize.len) return null;
    }

    return concat([
      head.subarray(0, segSizePos),
      segSizeBytes,
      head.subarray(segSizePos + segSize.len, info.start),
      newInfo,
      head.subarray(info.end),
    ]);
  }

  function readBytes(blob) {
    if (blob.arrayBuffer) return blob.arrayBuffer();
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsArrayBuffer(blob);
    });
  }

  // Returns a Blob with the duration set, or the original Blob unchanged if it
  // cannot be patched. Never throws.
  function fixDuration(blob, durationMs) {
    if (!blob || !blob.size || !(durationMs > 0)) return Promise.resolve(blob);
    var headLen = Math.min(blob.size, HEAD_BYTES);
    return readBytes(blob.slice(0, headLen)).then(function (buf) {
      var patched = patchHead(new Uint8Array(buf), durationMs);
      if (!patched) return blob;
      return new Blob([patched, blob.slice(headLen)], { type: blob.type });
    }).catch(function () {
      return blob;
    });
  }

  // Reads the Duration back out (in ms), or null if absent. Used by the tests.
  function readDuration(blob) {
    return readBytes(blob.slice(0, Math.min(blob.size, HEAD_BYTES))).then(function (buf) {
      var head = new Uint8Array(buf);
      var id = readVint(head, 0, true);
      if (!id || id.value !== ID_EBML) return null;
      var size = readVint(head, id.len, false);
      var p = id.len + size.len + size.value;
      var seg = readVint(head, p, true);
      var segSize = readVint(head, p + seg.len, false);
      p = p + seg.len + segSize.len;
      while (p < head.length) {
        var elId = readVint(head, p, true);
        var elSize = readVint(head, p + elId.len, false);
        var data = p + elId.len + elSize.len;
        if (elId.value === ID_INFO) {
          var scale = 1000000;
          var dur = null;
          var q = data;
          while (q < data + elSize.value) {
            var cId = readVint(head, q, true);
            var cSize = readVint(head, q + cId.len, false);
            var cData = q + cId.len + cSize.len;
            if (cId.value === ID_TIMECODE_SCALE) scale = readUint(head, cData, cSize.value);
            if (cId.value === ID_DURATION) {
              var view = new DataView(head.buffer, head.byteOffset + cData, cSize.value);
              dur = cSize.value === 8 ? view.getFloat64(0, false) : view.getFloat32(0, false);
            }
            q = cData + cSize.value;
          }
          return dur === null ? null : (dur * scale) / 1e6;
        }
        if (elSize.unknown) return null;
        p = data + elSize.value;
      }
      return null;
    });
  }

  AVR.webm = { fixDuration: fixDuration, readDuration: readDuration, _patchHead: patchHead };
})(window.AVR = window.AVR || {});
