# AV Recorder

Record your camera, screen and voice in the browser. Free, private, nothing to install, and it works on phones and computers, even offline.

**Use it:** https://avrecorder.wecanuseai.com/

Everything happens on your device. There are no accounts, no uploads and no trackers.

## What it does

**Recording**
- **Camera**: webcam or phone camera with sound. Front/back switching on phones, and 16:9, 9:16 (Shorts/Reels) or 1:1 framing.
- **Screen**: a whole screen, a window or a browser tab, with the tab's or computer's sound where the browser allows it.
- **Screen + Cam**: your screen with your camera in a bubble (circle, rounded or wide) that you drag anywhere. You can hide it mid-recording.
- **Audio**: voice-overs, podcasts and notes, with a live level display.
- Your microphone and the computer's sound are mixed into one track, so neither gets dropped.
- Pause and resume, a 3/5/10-second countdown with optional beeps, and mute during recording.
- Choose 720p to 4K at 24/30/60 fps, a quality level (YouTube's recommended bitrates by default), and the file format.

**For creators**
- **Teleprompter**: your script scrolls over the preview while you record. It's never part of the video. Speed, text size, mirroring for prompter glass, and auto-start with recording.
- **Floating controls** (Chrome/Edge on desktop): timer, pause, stop, mute and teleprompter in a small window that stays on top while you record other apps.
- **Save a frame** as a PNG from the live preview or from playback. Handy for thumbnails.
- **WAV export** of any recording's sound for editing.
- **Microphone level meter** with clipping warning, and a volume control.
- Keyboard shortcuts: `R` record/stop, `P`/`Space` pause, `M` mute, `C` camera bubble, `S` still image, `T` teleprompter, `?` help.

**Reliability**
- **Crash-safe.** The recording is written to the device every second. If the tab closes, the browser crashes or the battery dies, reopen the page and it is in *Your recordings*.
- **Long recordings** don't fill up memory, because they go to storage as they're made.
- **Files play and scrub properly.** WebM files get their duration written in, which browsers leave out, so players and editors can seek.
- **Keeps recording in the background.** Screen recordings keep their full frame rate while you work in another window.
- **Phones:** the screen stays awake while recording. If the camera is interrupted (you switch apps, or a call comes in), recording pauses instead of capturing a frozen picture, then resumes.
- If the camera, microphone or shared screen disappears mid-recording, what you have so far is saved.
- **Offline and installable:** after one visit it loads with no connection, and it can be installed as an app (*Install app* button, or *Share → Add to Home Screen* on iPhone).
- If the browser refuses storage (some private modes), recording still works; you're told to download before leaving.

**Your recordings**
- Kept in the browser with thumbnails, length, size and format.
- Play, download, share (phones: straight to YouTube, Photos, Drive…), rename, delete, or export sound as WAV.

## Browser support

| | Camera | Screen | Screen + Cam | Audio | Computer sound | Saves as |
|---|---|---|---|---|---|---|
| Chrome, Edge (Windows, Mac, Linux, ChromeOS) | ✅ | ✅ | ✅ | ✅ | Tab sound everywhere; whole system on Windows and ChromeOS | MP4 (H.264/AAC) where available, otherwise WebM |
| Firefox (desktop) | ✅ | ✅ | ✅ | ✅ | — | WebM |
| Safari (Mac) | ✅ | ✅ | ✅ | ✅ | — | MP4 |
| Chrome, Samsung Internet, Firefox (Android) | ✅ | — | — | ✅ | — | WebM or MP4 |
| Safari and other browsers (iPhone, iPad; iOS 14.3+) | ✅ | — | — | ✅ | — | MP4 |

Phones and tablets don't allow screen recording from a web page; use the device's built-in screen recorder for that. YouTube accepts both MP4 and WebM uploads directly.

Automated tests run in Chromium (see below). Other browsers are handled by checking each feature before using it, and by falling back to simpler settings rather than failing.

## How it works

It's a static site: plain HTML, CSS and JavaScript with no build step, framework or third-party requests. Everything is in this repository:

| Path | What it is |
|---|---|
| `index.html`, `style.css` | The page and its styles |
| `js/app.js` | The recorder: sources, preview, recording states and UI |
| `js/session.js` | One recording: MediaRecorder, chunked saving, timing, crash recovery |
| `js/store.js` | On-device storage (IndexedDB) |
| `js/compositor.js` | Screen + camera bubble and aspect-ratio cropping, drawn on a canvas |
| `js/audio-engine.js` | Level meters and microphone/computer-sound mixing |
| `js/formats.js` | Picks a recording format and bitrate the browser supports |
| `js/webm-duration.js` | Writes the missing duration into WebM files |
| `js/wav.js` | WAV export |
| `js/teleprompter.js`, `js/pip.js`, `js/library.js` | Teleprompter, floating controls, the recordings list |
| `js/icons.js` | Inline icon sprite, generated by `tools/build-icons.mjs` |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline support and app install |

### Run it locally

Any static file server works. Camera and microphone access needs `https://` or `localhost`:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

### Tests

The tests record real video and sound in Chromium using fake camera, microphone and screen devices:

```sh
cd tests
npm ci
npx playwright install chromium
npm test                  # add xvfb-run -a in front on Linux to include the background-tab test
```

They cover every mode, pause timing, WebM duration, WAV export, sound mixing, the camera bubble, 9:16 cropping, crash recovery, keyboard shortcuts, the teleprompter, missing storage, corrupt settings, phone layout, recording offline, and frame rate while the tab is hidden. They run on GitHub Actions for every pull request and push to `main`.

### Icons

Icons are [Phosphor](https://phosphoricons.com) (MIT). To add one, put its name in `tools/build-icons.mjs` and run `node tools/build-icons.mjs`.

## License

MIT. See [LICENSE.txt](LICENSE.txt).
