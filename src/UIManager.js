import { RECORDING_TYPES } from './constants.js';

/**
 * Manages all interactions with the DOM.
 */
export class UIManager {
  /**
   * Initializes the UI manager by getting references to all necessary DOM elements.
   */
  constructor() {
    this.startMicBtn = document.getElementById('startMic');
    this.stopMicBtn = document.getElementById('stopMic');
    this.startSystemBtn = document.getElementById('startSystem');
    this.stopSystemBtn = document.getElementById('stopSystem');
    this.startScreenAndMicBtn = document.getElementById('startScreenAndMic');
    this.stopScreenAndMicBtn = document.getElementById('stopScreenAndMic');
    this.startCameraBtn = document.getElementById('startCamera');
    this.stopCameraBtn = document.getElementById('stopCamera');
    this.statusElement = document.getElementById('status');
    this.timerElement = document.getElementById('timer');
    this.warningElement = document.getElementById('warning');
    this.logDiv = document.getElementById('log');
    this.checklistDiv = document.getElementById('checklist');

    this.stopMicBtn.disabled = true;
    this.stopSystemBtn.disabled = true;

    this.checklistItems = [
      'Grant microphone permissions',
      'Test microphone',
      'Grant system audio/video permissions',
      'Test system recording'
    ];

    this.renderChecklist();
  }

  /**
   * Renders the initial checklist in the UI.
   */
  renderChecklist() {
    this.checklistDiv.innerHTML = this.checklistItems
      .map((item, index) => `
        <div class="checklist-item" id="checklist-${index}">
          <input type="checkbox" disabled>
          <span>${item}</span>
        </div>
      `).join('');
  }

  /**
   * Updates the enabled/disabled state of the recording buttons.
   * @param {boolean} isRecording - Whether a recording is currently in progress.
   * @param {string} type - The type of recording ('microphone', 'system', etc.).
   */
  updateUI(isRecording, type) {
    if (type === RECORDING_TYPES.MICROPHONE) {
      this.startMicBtn.disabled = isRecording;
      this.stopMicBtn.disabled = !isRecording;
    } else if (type === RECORDING_TYPES.SYSTEM) {
      this.startSystemBtn.disabled = isRecording;
      this.stopSystemBtn.disabled = !isRecording;
    } else if (type === RECORDING_TYPES.SCREEN_AND_MIC) {
      this.startScreenAndMicBtn.disabled = isRecording;
      this.stopScreenAndMicBtn.disabled = !isRecording;
    } else if (type === RECORDING_TYPES.CAMERA) {
      this.startCameraBtn.disabled = isRecording;
      this.stopCameraBtn.disabled = !isRecording;
    }
  }

  /**
   * Updates a specific item in the checklist.
   * @param {number} index - The index of the checklist item to update.
   * @param {boolean} completed - Whether the item should be marked as completed.
   */
  updateChecklist(index, completed) {
    const checklistItem = document.getElementById(`checklist-${index}`);
    if (checklistItem) {
      const checkbox = checklistItem.querySelector('input[type="checkbox"]');
      checkbox.checked = completed;
      checklistItem.classList.toggle('completed', completed);
    }
  }

  /**
   * Logs a message to the log area in the UI.
   * @param {string} message - The message to log.
   */
  logMessage(message) {
    const logEntry = document.createElement('div');
    logEntry.textContent = `${new Date().toLocaleTimeString()}: ${message}`;
    this.logDiv.appendChild(logEntry);
    this.logDiv.scrollTop = this.logDiv.scrollHeight;
  }

  /**
   * Logs an error message to the log area in the UI.
   * @param {string} message - The error message to log.
   */
  logError(message) {
    const errorEntry = document.createElement('div');
    errorEntry.className = 'error-message';
    errorEntry.textContent = `${new Date().toLocaleTimeString()}: Error - ${message}`;
    this.logDiv.appendChild(errorEntry);
    this.logDiv.scrollTop = this.logDiv.scrollHeight;
  }

  /**
   * Updates the status indicator in the UI.
   * @param {boolean} isRecording - Whether a recording is in progress.
   */
  updateStatus(isRecording) {
    if (isRecording) {
      this.statusElement.textContent = 'Recording...';
      this.statusElement.classList.add('recording');
    } else {
      this.statusElement.textContent = 'Stopped';
      this.statusElement.classList.remove('recording');
      // Hide the status after a delay
      setTimeout(() => {
        this.statusElement.textContent = '';
        this.statusElement.style.opacity = '0';
      }, 2000);
    }
  }

  /**
   * Updates the timer display.
   * @param {number} seconds - The total seconds of the recording.
   */
  updateTimer(seconds) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    const formattedTime = `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
    this.timerElement.textContent = formattedTime;
  }

  /**
   * Shows the memory usage warning message.
   */
  showWarning() {
    this.warningElement.style.display = 'block';
  }
}
