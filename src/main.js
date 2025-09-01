import { UIManager } from './UIManager.js';
import { RecorderService } from './RecorderService.js';
import { RECORDING_TYPES } from './constants.js';
import { DeviceManager } from './DeviceManager.js';

/**
 * The main application class.
 * Orchestrates the UI Manager and the Recorder Service.
 */
class App {
  /**
   * Initializes the application.
   */
  constructor() {
    this.sessionStartTime = Date.now();
    this.recordings = new Map();
    this.uiManager = new UIManager();
    this.recorderService = new RecorderService({
      updateChecklist: this.uiManager.updateChecklist.bind(this.uiManager),
      logError: this.uiManager.logError.bind(this.uiManager),
      updateTimer: this.uiManager.updateTimer.bind(this.uiManager),
      showWarning: this.uiManager.showWarning.bind(this.uiManager),
      onSave: this.handleSave.bind(this),
    });

    this.setupEventListeners();
    this.setupThemeSwitcher();
    this.deviceManager = new DeviceManager();
    this.populateDevices();
  }

  async populateDevices() {
    const devices = await this.deviceManager.getDevices();
    this.uiManager.populateDeviceLists(devices);
  }

  handleSave(recording) {
    const id = `rec-${Date.now()}`;
    const recordingWithId = { ...recording, id };
    this.recordings.set(id, recordingWithId);

    this.uiManager.logMessage(`Recording of type '${recording.type}' saved.`);
    this.uiManager.addRecordingToTimeline(
      recordingWithId,
      this.sessionStartTime,
      this.previewRecording.bind(this),
      this.deleteRecording.bind(this)
    );
  }

  deleteRecording(id) {
    this.recordings.delete(id);
    this.uiManager.removeRecordingFromTimeline(id);
  }

  previewRecording(id) {
    const recording = this.recordings.get(id);
    if (!recording) return;

    const blobUrl = URL.createObjectURL(recording.blob);

    const downloadHandler = () => {
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = blobUrl;
      a.download = `${recording.type}-${new Date(recording.startTime).toISOString()}.webm`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
      }, 100);
    };

    this.uiManager.showPreview(blobUrl, downloadHandler);
  }

  /**
   * Sets up the event listeners for the recording buttons.
   */
  setupEventListeners() {
    // Microphone
    this.uiManager.startMicBtn.addEventListener('click', () => this.handleRecording(RECORDING_TYPES.MICROPHONE, 'start'));
    this.uiManager.pauseMicBtn.addEventListener('click', () => this.handleRecording(RECORDING_TYPES.MICROPHONE, 'pause'));
    this.uiManager.resumeMicBtn.addEventListener('click', () => this.handleRecording(RECORDING_TYPES.MICROPHONE, 'resume'));
    this.uiManager.stopMicBtn.addEventListener('click', () => this.handleRecording(RECORDING_TYPES.MICROPHONE, 'stop'));
    // System
    this.uiManager.startSystemBtn.addEventListener('click', () => this.handleRecording(RECORDING_TYPES.SYSTEM, 'start'));
    this.uiManager.pauseSystemBtn.addEventListener('click', () => this.handleRecording(RECORDING_TYPES.SYSTEM, 'pause'));
    this.uiManager.resumeSystemBtn.addEventListener('click', () => this.handleRecording(RECORDING_TYPES.SYSTEM, 'resume'));
    this.uiManager.stopSystemBtn.addEventListener('click', () => this.handleRecording(RECORDING_TYPES.SYSTEM, 'stop'));
    // Camera
    this.uiManager.startCameraBtn.addEventListener('click', () => this.handleRecording(RECORDING_TYPES.CAMERA, 'start'));
    this.uiManager.pauseCameraBtn.addEventListener('click', () => this.handleRecording(RECORDING_TYPES.CAMERA, 'pause'));
    this.uiManager.resumeCameraBtn.addEventListener('click', () => this.handleRecording(RECORDING_TYPES.CAMERA, 'resume'));
    this.uiManager.stopCameraBtn.addEventListener('click', () => this.handleRecording(RECORDING_TYPES.CAMERA, 'stop'));
  }

  /**
   * Handles all recording actions (start, pause, resume, stop).
   * @param {string} type - The type of recording.
   * @param {string} action - The action to perform.
   */
  async handleRecording(type, action) {
    switch (action) {
      case 'start':
        this.uiManager.updateUI(type, 'recording');
        this.uiManager.updateStatus(true);
        try {
          const audioDeviceId = this.uiManager.audioInputSelect.value;
          const videoDeviceId = this.uiManager.videoInputSelect.value;
          await this.recorderService.startRecording(type, { audio: audioDeviceId, video: videoDeviceId });
        } catch (error) {
          this.uiManager.updateUI(type, 'stopped');
          this.uiManager.updateStatus(false);

          let errorMessage = 'An unknown error occurred.';
          switch (error.name) {
            case 'NotAllowedError':
            case 'SecurityError':
              errorMessage = 'Permission denied. Please allow access to your microphone/screen and ensure you are on a secure (HTTPS) connection.';
              break;
            case 'NotFoundError':
              errorMessage = 'No media devices found. Please ensure you have a working microphone/camera.';
              break;
            case 'NotReadableError':
              errorMessage = 'Could not read from your media device. It might be in use by another application.';
              break;
            case 'AbortError':
              errorMessage = 'The request was aborted. Please try again.';
              break;
            default:
              errorMessage = `An unexpected error occurred: ${error.name} - ${error.message}`;
              break;
          }
          this.uiManager.logError(errorMessage);
        }
        break;
      case 'pause':
        this.recorderService.pauseRecording();
        this.uiManager.updateUI(type, 'paused');
        break;
      case 'resume':
        this.recorderService.resumeRecording();
        this.uiManager.updateUI(type, 'recording');
        break;
      case 'stop':
        this.recorderService.stopRecording();
        this.uiManager.updateUI(type, 'stopped');
        this.uiManager.updateStatus(false);
        break;
    }
  }

  /**
   * Sets up the theme switcher logic, including system theme detection.
   */
  setupThemeSwitcher() {
    const themeToggleBtn = document.getElementById('theme-toggle-btn');
    const themeIcon = document.getElementById('theme-icon');
    const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)');

    const applyTheme = (theme) => {
      document.body.setAttribute('data-theme', theme);
      themeIcon.className = theme === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
      localStorage.setItem('theme', theme);
    };

    const toggleTheme = () => {
      const currentTheme = document.body.getAttribute('data-theme');
      const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
      applyTheme(newTheme);
    };

    themeToggleBtn.addEventListener('click', toggleTheme);

    // Listen for changes in system preference
    systemPrefersDark.addEventListener('change', e => {
      // Only apply if no user preference is set
      if (!localStorage.getItem('theme')) {
        applyTheme(e.matches ? 'dark' : 'light');
      }
    });

    // Initial theme setup
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme) {
      applyTheme(savedTheme);
    } else {
      applyTheme(systemPrefersDark.matches ? 'dark' : 'light');
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new App();
});
