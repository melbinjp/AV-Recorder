# Changelog

Each release bumps the version in `js/version.js` and adds a section here. A test fails if they disagree.

## 2.0.1 (2026-09-24)

**Fixed**
- Some WebM recordings were saved without a duration, so they could not be scrubbed. This happened when the first video frame arrived more than a second after recording started, as with a slow camera start or a busy phone. Chrome then splits the file header across chunks, starting with a single byte, and the header was only looked for in the first chunk. It is now found and patched wherever it falls, both when saving and when recovering after a crash.

## 2.0.0 (2026-09-24)

A rebuild focused on never losing a recording, on every device.

**Fixed**
- Safari, iPhone and iPad could not record at all: only WebM was requested, and their recorder makes MP4. Files are now named after what was actually recorded.
- Recording the screen with the microphone dropped one of the two sound sources. They are now mixed into one track.
- A crash, closed tab or dead battery lost the whole recording, and long recordings could run a phone out of memory.
- WebM files had no duration, so players and editors could not seek.
- Camera and microphone access was requested on page load, and failed outright on machines without a camera.

**Dependability**
- Recordings are written to the device every second and recovered on the next visit after a crash.
- If the browser's encoder fails mid-take, part 1 is saved and recording carries on as part 2.
- If device storage fails, recording falls back to memory. At a set limit it stops and saves, rather than risk the tab being killed.
- Saving can never hang on a stalled browser store, and nothing unconfirmed is lost.
- Warnings before and during recording when the device is running out of space.
- Screen recordings keep full frame rate while the tab is in the background.
- On phones: the screen stays awake, and an interrupted camera pauses the recording instead of recording a frozen picture.
- Works offline after one visit, and can be installed as an app.
- Help → Diagnostics: an on-device event log and capability report for bug reports.

**New**
- Screen + Cam with a draggable camera bubble.
- 9:16 and 1:1 framing for Shorts and Reels.
- Teleprompter.
- Floating controls that stay on top of other apps.
- Countdown, pause and mute.
- Resolution up to 4K, frame rate, quality and format settings.
- Level meter with volume.
- Still frames for thumbnails, and WAV export.
- A recordings library with share-to-app on phones.
- Keyboard shortcuts.

**Engineering**
- Split into focused modules. No build step and no runtime dependencies.
- Content-Security-Policy. No third-party requests besides the shared favicon.
- Browser tests (real recordings with fake devices), unit tests, lint, a size budget and consistency checks, run in CI on every pull request.
- 44 MB of unused icon fonts replaced by a 43 KB icon sprite.
