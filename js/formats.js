// Picks a recording format the current browser can actually produce.
//
// Browsers differ: Safari (macOS, iPhone, iPad) records MP4 only, Firefox
// records WebM only, and Chrome/Edge record WebM everywhere plus MP4 with
// H.264/AAC on most systems. "Auto" prefers MP4 with H.264 + AAC because every
// video editor and phone plays it, and falls back to WebM, which YouTube also
// accepts.
(function (AVR) {
  'use strict';

  var VIDEO = [
    { mime: 'video/mp4;codecs=avc1,mp4a.40.2', label: 'MP4 (H.264 + AAC)', ext: 'mp4' },
    { mime: 'video/mp4;codecs=avc1.640028,mp4a.40.2', label: 'MP4 (H.264 + AAC)', ext: 'mp4' },
    { mime: 'video/mp4;codecs=avc1.4d002a,mp4a.40.2', label: 'MP4 (H.264 + AAC)', ext: 'mp4' },
    { mime: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', label: 'MP4 (H.264 + AAC)', ext: 'mp4' },
    { mime: 'video/webm;codecs=vp9,opus', label: 'WebM (VP9 + Opus)', ext: 'webm' },
    { mime: 'video/webm;codecs=vp8,opus', label: 'WebM (VP8 + Opus)', ext: 'webm' },
    { mime: 'video/webm;codecs=h264,opus', label: 'WebM (H.264 + Opus)', ext: 'webm' },
    { mime: 'video/webm', label: 'WebM', ext: 'webm' },
    { mime: 'video/mp4', label: 'MP4', ext: 'mp4' },
  ];

  var AUDIO = [
    { mime: 'audio/mp4;codecs=mp4a.40.2', label: 'M4A (AAC)', ext: 'm4a' },
    { mime: 'audio/webm;codecs=opus', label: 'WebM (Opus)', ext: 'webm' },
    { mime: 'audio/ogg;codecs=opus', label: 'Ogg (Opus)', ext: 'ogg' },
    { mime: 'audio/mp4', label: 'M4A', ext: 'm4a' },
    { mime: 'audio/webm', label: 'WebM audio', ext: 'webm' },
  ];

  function supported(mime) {
    try {
      return typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(mime);
    } catch (e) {
      return false;
    }
  }

  // Safari may not recognise every explicit codec string, but whenever it can
  // record MP4 at all that is H.264/AAC, which is what iPhones and Macs want.
  // Elsewhere a bare "video/mp4" can mean less compatible codecs, so it stays last.
  function candidates(kind) {
    var base = kind === 'audio' ? AUDIO : VIDEO;
    if (!(AVR.platform && (AVR.platform.isSafari || AVR.platform.isIOS))) return base;
    var generic = kind === 'audio' ? 'audio/mp4' : 'video/mp4';
    var mp4 = base.filter(function (f) { return f.mime.indexOf(generic) === 0; });
    var rest = base.filter(function (f) { return f.mime.indexOf(generic) !== 0; });
    return mp4.concat(rest);
  }

  var cache = {};
  function list(kind) {
    if (cache[kind]) return cache[kind];
    var seen = {};
    cache[kind] = candidates(kind).filter(function (f) {
      if (seen[f.label] || !supported(f.mime)) return false;
      seen[f.label] = true;
      return true;
    });
    return cache[kind];
  }

  // Returns the chosen format, or null to let the browser use its default.
  function pick(kind, preferred) {
    var options = list(kind);
    if (preferred && preferred !== 'auto') {
      for (var i = 0; i < options.length; i++) if (options[i].mime === preferred) return options[i];
    }
    return options[0] || null;
  }

  function extFor(mime, kind) {
    var m = String(mime || '').toLowerCase();
    if (m.indexOf('mp4') !== -1 || m.indexOf('m4a') !== -1 || m.indexOf('quicktime') !== -1) {
      return kind === 'audio' ? 'm4a' : 'mp4';
    }
    if (m.indexOf('ogg') !== -1) return 'ogg';
    return 'webm';
  }

  // Base container type without codecs, for Blob types and <video> playback.
  function baseType(mime, kind) {
    var m = String(mime || '').split(';')[0].trim();
    return m || (kind === 'audio' ? 'audio/webm' : 'video/webm');
  }

  // YouTube's recommended upload bitrates (SDR), keyed by the long side of the frame.
  var TIERS = [
    { long: 1280, b30: 5e6, b60: 7.5e6 },
    { long: 1920, b30: 8e6, b60: 12e6 },
    { long: 2560, b30: 16e6, b60: 24e6 },
    { long: 3840, b30: 35e6, b60: 53e6 },
  ];
  var QUALITY = { standard: 0.5, high: 1, max: 1.6 };

  function videoBitrate(width, height, fps, quality) {
    var long = Math.max(width || 0, height || 0) || 1920;
    var tier = TIERS[0];
    for (var i = 0; i < TIERS.length; i++) if (long >= TIERS[i].long * 0.9) tier = TIERS[i];
    var base = (fps || 30) > 30 ? tier.b60 : tier.b30;
    if (long < 1100) base = base * Math.max(0.35, (long / 1280) * (long / 1280));
    var bits = base * (QUALITY[quality] || 1);
    return Math.round(Math.min(80e6, Math.max(1e6, bits)));
  }

  function audioBitrate(quality) {
    return quality === 'standard' ? 128000 : 192000;
  }

  // Frame size for a resolution preset, as {long, short}.
  function presetSize(resolution) {
    var short = parseInt(resolution, 10) || 1080;
    return { long: Math.round((short * 16) / 9), short: short };
  }

  AVR.formats = {
    list: list,
    pick: pick,
    extFor: extFor,
    baseType: baseType,
    videoBitrate: videoBitrate,
    audioBitrate: audioBitrate,
    presetSize: presetSize,
    supported: supported,
  };
})(window.AVR = window.AVR || {});
