# Audio-Video Recorder

A modern web-based audio and video recording tool that allows you to capture both microphone audio and screen recordings directly in your browser. No downloads or installations required!

## 🌟 Features

- **Microphone Recording**: Capture high-quality audio from your microphone
- **Screen Recording**: Record your entire screen or specific applications
- **Real-time Controls**: Start, stop, and manage recordings with intuitive buttons
- **Download Support**: Save recordings in common formats
- **Browser-Based**: Works entirely in your browser - no software installation needed
- **Cross-Platform**: Compatible with Windows, macOS, and Linux

## 🚀 Usage

### Microphone Recording
1. Click "Start Recording Microphone" to begin audio capture
2. Speak into your microphone
3. Click "Stop Recording Microphone" when finished
4. Download your audio recording

### Screen Recording
1. Click "Start Screen Recording" to begin screen capture
2. Select the screen or application window to record
3. Perform your actions on screen
4. Click "Stop Screen Recording" when finished
5. Download your screen recording

## 🛠️ Requirements

- **Modern Browser**: Chrome, Firefox, Safari, or Edge (latest versions)
- **Microphone**: For audio recording (built-in or external)
- **Camera**: For video recording (optional)
- **HTTPS**: Required for accessing media devices (camera/microphone)

## 🔧 Technical Details

- **Web APIs**: Uses MediaRecorder API and MediaStream API
- **Modular Architecture**: Code is split into `UIManager`, `RecorderService`, and `App` modules for better maintainability.
- **File Downloads**: Automatic download of recorded files in WebM format.
- **Responsive Design**: Works on desktop and mobile devices.

## 📱 Browser Compatibility

| Browser | Audio Recording | Screen Recording |
|---------|----------------|------------------|
| Chrome  | ✅ Full Support | ✅ Full Support |
| Firefox | ✅ Full Support | ✅ Full Support |
| Safari  | ✅ Full Support | ⚠️ Limited Support |
| Edge    | ✅ Full Support | ✅ Full Support |

## 🚨 Permissions

The app will request permission to:
- Access your microphone (for audio recording)
- Access your screen (for screen recording)
- Download files (for saving recordings)

## 📄 License

This project is licensed under the MIT License - see the [LICENSE.txt](LICENSE.txt) file for details.

## 🌐 Live Demo

Try the audio-video recorder: [Demo Link]

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📝 Notes

- Screen recording requires HTTPS in production
- Some browsers may have limitations on screen recording
- Recording quality depends on your hardware and browser capabilities 