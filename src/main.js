import { UIManager } from './UIManager.js';
import { RecorderService } from './RecorderService.js';
import { RECORDING_TYPES } from './constants.js';

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
  }

  handleSave(recording) {
    this.uiManager.logMessage(`Recording of type '${recording.type}' saved.`);
    this.uiManager.addRecordingToTimeline(recording, this.sessionStartTime);
  }

  /**
   * Sets up the event listeners for the recording buttons.
   */
  setupEventListeners() {
    this.uiManager.startMicBtn.addEventListener('click', () => this.handleRecording(RECORDING_TYPES.MICROPHONE, true));
    this.uiManager.stopMicBtn.addEventListener('click', () => this.handleRecording(RECORDING_TYPES.MICROPHONE, false));
    this.uiManager.startSystemBtn.addEventListener('click', () => this.handleRecording(RECORDING_TYPES.SYSTEM, true));
    this.uiManager.stopSystemBtn.addEventListener('click', () => this.handleRecording(RECORDING_TYPES.SYSTEM, false));
    this.uiManager.startCameraBtn.addEventListener('click', () => this.handleRecording(RECORDING_TYPES.CAMERA, true));
    this.uiManager.stopCameraBtn.addEventListener('click', () => this.handleRecording(RECORDING_TYPES.CAMERA, false));
  }

  /**
   * Handles the start and stop recording logic.
   * @param {string} type - The type of recording.
   * @param {boolean} start - Whether to start or stop the recording.
   */
  async handleRecording(type, start) {
    if (start) {
      // Optimistically update UI
      this.uiManager.updateUI(true, type);
      this.uiManager.updateStatus(true);
      try {
        await this.recorderService.startRecording(type);
      } catch (error) {
        this.recorderService.isRecording = false; // Correct the state
        this.uiManager.updateUI(false, type); // Revert UI
        this.uiManager.updateStatus(false); // Revert status

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
    } else {
      this.recorderService.stopRecording();
      this.uiManager.updateUI(false, type);
      this.uiManager.updateStatus(false);
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
