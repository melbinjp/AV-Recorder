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
    this.startCameraBtn = document.getElementById('startCamera');
    this.stopCameraBtn = document.getElementById('stopCamera');
    this.pauseMicBtn = document.getElementById('pauseMic');
    this.resumeMicBtn = document.getElementById('resumeMic');
    this.pauseSystemBtn = document.getElementById('pauseSystem');
    this.resumeSystemBtn = document.getElementById('resumeSystem');
    this.pauseCameraBtn = document.getElementById('pauseCamera');
    this.resumeCameraBtn = document.getElementById('resumeCamera');
    this.audioInputSelect = document.getElementById('audio-input');
    this.videoInputSelect = document.getElementById('video-input');
    this.statusElement = document.getElementById('status');
    this.timerElement = document.getElementById('timer');
    this.warningElement = document.getElementById('warning');
    this.previewContainer = document.getElementById('preview-container');
    this.previewVideo = document.getElementById('preview-video');
    this.downloadBtn = document.getElementById('download-btn');
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
   * Updates the UI based on the current recording state.
   * @param {string} type - The type of recording.
   * @param {string} state - The current state ('recording', 'paused', 'stopped').
   */
  updateUI(type, state) {
    const buttons = this.getButtonsForType(type);
    if (!buttons) return;

    buttons.start.style.display = state === 'stopped' ? 'inline-flex' : 'none';
    buttons.pause.style.display = state === 'recording' ? 'inline-flex' : 'none';
    buttons.resume.style.display = state === 'paused' ? 'inline-flex' : 'none';
    buttons.stop.style.display = (state === 'recording' || state === 'paused') ? 'inline-flex' : 'none';

    buttons.pause.disabled = false;
    buttons.resume.disabled = false;
    buttons.stop.disabled = false;
  }

  getButtonsForType(type) {
    if (type === RECORDING_TYPES.MICROPHONE) {
      return { start: this.startMicBtn, stop: this.stopMicBtn, pause: this.pauseMicBtn, resume: this.resumeMicBtn };
    }
    if (type === RECORDING_TYPES.SYSTEM) {
      return { start: this.startSystemBtn, stop: this.stopSystemBtn, pause: this.pauseSystemBtn, resume: this.resumeSystemBtn };
    }
    if (type === RECORDING_TYPES.CAMERA) {
      return { start: this.startCameraBtn, stop: this.stopCameraBtn, pause: this.pauseCameraBtn, resume: this.resumeCameraBtn };
    }
    return null;
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

  /**
   * Adds a new recording block to the timeline visualization.
   * @param {object} recording - The recording metadata.
   * @param {number} sessionStartTime - The start time of the session.
   * @param {function} previewCallback - The callback for previewing a recording.
   * @param {function} deleteCallback - The callback for deleting a recording.
   */
  addRecordingToTimeline(recording, sessionStartTime, previewCallback, deleteCallback) {
    const timelineScale = 0.1; // 1 pixel per 10ms, or 100px per second
    const track = document.querySelector(`.track[data-track-type="${recording.type}"]`);
    if (!track) return;

    const block = document.createElement('div');
    block.className = 'recording-block';
    block.id = `rec-block-${recording.id}`;
    block.style.left = `${(recording.startTime - sessionStartTime) * timelineScale}px`;
    block.style.width = `${recording.duration * timelineScale}px`;

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-btn';
    deleteBtn.innerHTML = '<i class="fas fa-trash"></i>';
    deleteBtn.addEventListener('click', () => {
      deleteCallback(recording.id);
    });
    block.appendChild(deleteBtn);

    block.addEventListener('click', (e) => {
      if (e.target.closest('.delete-btn')) return;
      previewCallback(recording.id);
    });

    track.appendChild(block);
  }

  /**
   * Shows the preview player with the specified video.
   * @param {string} blobUrl - The URL of the blob to preview.
   * @param {function} downloadHandler - The handler for the download button.
   */
  showPreview(blobUrl, downloadHandler) {
    this.previewVideo.src = blobUrl;
    this.downloadBtn.onclick = downloadHandler;
    this.previewContainer.style.display = 'block';
  }

  removeRecordingFromTimeline(id) {
    const block = document.getElementById(`rec-block-${id}`);
    if (block) {
      block.remove();
    }
  }

  populateDeviceLists(devices) {
    this.audioInputSelect.innerHTML = '';
    this.videoInputSelect.innerHTML = '';

    devices.audio.forEach(device => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.text = device.label || `Microphone ${this.audioInputSelect.options.length + 1}`;
      this.audioInputSelect.appendChild(option);
    });

    devices.video.forEach(device => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.text = device.label || `Camera ${this.videoInputSelect.options.length + 1}`;
      this.videoInputSelect.appendChild(option);
    });
  }
}
