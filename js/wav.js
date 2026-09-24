// Converts a recording's audio to an uncompressed 16-bit WAV file, which every
// audio and video editor opens. Works for audio-only and video recordings (the
// video track is ignored), entirely in the browser.
(function (AVR) {
  'use strict';

  var SAMPLE_RATE = 48000;

  function decode(arrayBuffer, channels) {
    var Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Offline) return Promise.reject(new Error('This browser cannot decode audio.'));
    // decodeAudioData resamples to the context's rate, so this yields 48 kHz,
    // the standard rate for video.
    var ctx = new Offline(channels, 1, SAMPLE_RATE);
    return new Promise(function (resolve, reject) {
      var settled = false;
      function ok(buf) { if (!settled) { settled = true; resolve(buf); } }
      function fail(err) { if (!settled) { settled = true; reject(err || new Error('Could not decode the audio.')); } }
      // Older Safari only supports the callback form and returns undefined.
      var p = ctx.decodeAudioData(arrayBuffer, ok, fail);
      if (p && p.then) p.then(ok, fail);
    });
  }

  function encode(audioBuffer) {
    var channels = Math.min(2, audioBuffer.numberOfChannels);
    var rate = audioBuffer.sampleRate;
    var frames = audioBuffer.length;
    var data = [];
    for (var c = 0; c < channels; c++) data.push(audioBuffer.getChannelData(c));

    var bytesPerFrame = channels * 2;
    var dataLen = frames * bytesPerFrame;
    var header = new ArrayBuffer(44);
    var v = new DataView(header);
    function str(off, s) { for (var i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); }
    str(0, 'RIFF');
    v.setUint32(4, 36 + dataLen, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); // PCM
    v.setUint16(22, channels, true);
    v.setUint32(24, rate, true);
    v.setUint32(28, rate * bytesPerFrame, true);
    v.setUint16(32, bytesPerFrame, true);
    v.setUint16(34, 16, true);
    str(36, 'data');
    v.setUint32(40, dataLen, true);

    // Build the body in slices so a long recording never needs one huge buffer.
    var parts = [header];
    var SLICE = 1 << 18;
    for (var start = 0; start < frames; start += SLICE) {
      var end = Math.min(frames, start + SLICE);
      var out = new Int16Array((end - start) * channels);
      var o = 0;
      for (var i = start; i < end; i++) {
        for (var ch = 0; ch < channels; ch++) {
          var s = data[ch][i];
          s = s < -1 ? -1 : s > 1 ? 1 : s;
          out[o++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
      }
      parts.push(out.buffer);
    }
    return new Blob(parts, { type: 'audio/wav' });
  }

  function fromBlob(blob) {
    var read = blob.arrayBuffer ? blob.arrayBuffer() : new Response(blob).arrayBuffer();
    return read.then(function (buf) {
      return decode(buf, 2);
    }).then(encode);
  }

  AVR.wav = { fromBlob: fromBlob, encode: encode };
})(window.AVR = window.AVR || {});
