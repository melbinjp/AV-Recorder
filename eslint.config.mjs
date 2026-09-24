// Lint rules for the app, the service worker and the tests.
//
// The rules are listed explicitly (no shared preset) so there is nothing to
// install beyond eslint itself, and each one is here because it catches a real
// class of bug: typos in names, unused leftovers, shadowed globals, fallthrough.
// Run: cd tests && npm run lint

const browser = [
  'window', 'self', 'document', 'navigator', 'location', 'console', 'performance', 'screen',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame',
  'URL', 'URLSearchParams', 'Blob', 'File', 'FileReader', 'Response', 'Request', 'fetch', 'Event',
  'MediaStream', 'MediaRecorder', 'Worker', 'indexedDB', 'IDBKeyRange', 'caches',
  'DataView', 'ArrayBuffer', 'Uint8Array', 'Int16Array', 'Float32Array', 'Promise', 'JSON', 'Math',
];

const shared = {
  'no-undef': 'error',
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
  'no-redeclare': 'error',
  'no-dupe-keys': 'error',
  'no-duplicate-case': 'error',
  'no-unreachable': 'error',
  'no-fallthrough': 'error',
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'no-cond-assign': 'error',
  'no-const-assign': 'error',
  'no-func-assign': 'error',
  'no-shadow-restricted-names': 'error',
  'no-sparse-arrays': 'error',
  'no-unsafe-finally': 'error',
  'no-unsafe-negation': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
  'eqeqeq': ['error', 'smart'],
  'no-var': 'off',
};

const toGlobals = (names) => Object.fromEntries(names.map((n) => [n, 'readonly']));

export default [
  { ignores: ['**/node_modules/**', 'tests/test-results/**'] },
  {
    // The app: classic scripts sharing window.AVR, written for older Safari.
    files: ['js/**/*.js'],
    languageOptions: { ecmaVersion: 2019, sourceType: 'script', globals: toGlobals(browser) },
    rules: shared,
  },
  {
    files: ['sw.js'],
    languageOptions: {
      ecmaVersion: 2019,
      sourceType: 'script',
      globals: toGlobals(['self', 'caches', 'fetch', 'Request', 'Response', 'URL', 'Promise', 'importScripts']),
    },
    rules: shared,
  },
  {
    files: ['tests/**/*.mjs', 'tools/**/*.mjs', 'eslint.config.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: toGlobals([
        'process', 'console', 'setTimeout', 'clearTimeout', 'fetch', 'WebSocket', 'URL',
        // Browser globals inside page.evaluate() callbacks:
        'window', 'document', 'navigator', 'caches', 'Event', 'MediaStreamTrackProcessor', 'OfflineAudioContext',
        'Blob', 'Uint8Array', 'DataView', 'localStorage', 'sessionStorage',
      ]),
    },
    rules: shared,
  },
];
