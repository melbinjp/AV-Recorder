import { RECORDING_TYPES } from './constants.js';

/**
 * Handles the core logic of recording audio and video streams.
 */
export class RecorderService {
  static MIME_TYPES = {
    audio: 'audio/webm;codecs=opus',
    video: 'video/webm;codecs=vp8,opus',
    systemAudio: 'audio/webm;codecs=opus'
  };

  /**
   * @param {object} callbacks - Callbacks for updating the UI.
   * @param {function} callbacks.updateChecklist - Callback to update the checklist.
   * @param {function} callbacks.logError - Callback to log an error message.
   * @param {function} callbacks.logMessage - Callback to log a message.
   */
  constructor(callbacks) {
    this.callbacks = callbacks;
    this.mediaRecorder = null;
    this.systemAudioRecorder = null;
    this.audioChunks = [];
    this.videoChunks = [];
    this.systemAudioChunks = [];
    this.isRecording = false;
    this.startTime = 0;
    this.timerInterval = null;

    this.setupAudioCapabilities();
  }

  /**
   * Checks for microphone permissions and updates the checklist accordingly.
   */
  async setupAudioCapabilities() {
    try {
      const permission = await navigator.permissions.query({ name: 'microphone' });
      if (permission.state === 'granted') {
        this.callbacks.updateChecklist(0, true);
      }
    } catch (error) {
      this.callbacks.logError('Failed to setup audio capabilities: ' + error.message);
    }
  }

  /**
   * Starts a recording of the specified type.
   * @param {string} type - The type of recording ('microphone', 'system', 'screen_and_mic').
   * @throws {Error} If the recording fails to start.
   */
  async startRecording(type) {
    let stream;
    if (type === RECORDING_TYPES.MICROPHONE) {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.callbacks.updateChecklist(1, true);
    } else if (type === RECORDING_TYPES.SYSTEM) { // 'system' recording
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true
      });

      const videoTrack = displayStream.getVideoTracks()[0];
      const audioTrack = displayStream.getAudioTracks()[0];

      const combinedStream = new MediaStream();
      if (videoTrack) {
        combinedStream.addTrack(videoTrack);
      }
      if (audioTrack) {
        combinedStream.addTrack(audioTrack);
        this.callbacks.updateChecklist(2, true);
      }

      stream = combinedStream;
      this.callbacks.updateChecklist(3, true);
    } else if (type === RECORDING_TYPES.SCREEN_AND_MIC) {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });

      const videoTrack = displayStream.getVideoTracks()[0];
      const audioTrack = voiceStream.getAudioTracks()[0];

      const combinedStream = new MediaStream();
      if (videoTrack) {
        combinedStream.addTrack(videoTrack);
      }
      if (audioTrack) {
        combinedStream.addTrack(audioTrack);
      }
      stream = combinedStream;
    } else if (type === RECORDING_TYPES.CAMERA) {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    }

    this.startTime = Date.now();
    this.mediaRecorder = new MediaRecorder(stream, {
      mimeType: type === RECORDING_TYPES.MICROPHONE ?
        RecorderService.MIME_TYPES.audio :
        RecorderService.MIME_TYPES.video
    });

    this.setupRecordingHandlers(type);
    this.mediaRecorder.start();
    this.isRecording = true;

    this.timerInterval = setInterval(() => {
      const seconds = Math.floor((Date.now() - this.startTime) / 1000);
      this.callbacks.updateTimer(seconds);
      if (seconds >= 300) { // 5 minutes
        this.callbacks.showWarning();
      }
    }, 1000);
  }

  /**
   * Sets up the data available and stop handlers for the media recorder.
   * @param {string} type - The type of recording.
   */
  setupRecordingHandlers(type) {
    const chunks = type === 'microphone' ? this.audioChunks : this.videoChunks;

    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    };

    this.mediaRecorder.onstop = () => {
      const mimeType = type === 'microphone' ?
        RecorderService.MIME_TYPES.audio :
        RecorderService.MIME_TYPES.video;

      const blob = new Blob(chunks, { type: mimeType });
      this.saveRecording(blob, type);
      chunks.length = 0;
    };
  }

  /**
   * Stops the current recording.
   */
  stopRecording() {
    if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') return;

    this.mediaRecorder.stop();
    this.mediaRecorder.stream.getTracks().forEach(track => track.stop());

    clearInterval(this.timerInterval);
    this.isRecording = false;
  }

  /**
   * Saves the recorded blob as a file.
   * @param {Blob} blob - The blob to save.
   * @param {string} type - The type of recording, used for the filename.
   */
  saveRecording(blob, type) {
    const duration = (Date.now() - this.startTime) / 1000;
    this.callbacks.logMessage(`Recording saved. Duration: ${duration.toFixed(2)}s`);

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = `${type}-${new Date().toISOString()}.webm`;

    document.body.appendChild(a);
    a.click();

    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }
}
