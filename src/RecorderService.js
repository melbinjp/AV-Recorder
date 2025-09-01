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
   * @param {function} callbacks.onSave - Callback to handle a saved recording.
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
    this.elapsedSeconds = 0;

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
   * @param {string} type - The type of recording.
   * @param {object} deviceIds - The IDs of the devices to use.
   * @throws {Error} If the recording fails to start.
   */
  async startRecording(type, deviceIds) {
    let stream;
    const audioConstraint = deviceIds.audio ? { deviceId: { exact: deviceIds.audio } } : true;
    const videoConstraint = deviceIds.video ? { deviceId: { exact: deviceIds.video } } : true;

    if (type === RECORDING_TYPES.MICROPHONE) {
      stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint });
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
    } else if (type === RECORDING_TYPES.CAMERA) {
      stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraint, audio: audioConstraint });
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
    this.elapsedSeconds = 0;
    this.callbacks.updateTimer(this.elapsedSeconds);

    this.timerInterval = setInterval(() => {
      this.elapsedSeconds++;
      this.callbacks.updateTimer(this.elapsedSeconds);
      if (this.elapsedSeconds >= 300) { // 5 minutes
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
      const mimeType = type === RECORDING_TYPES.MICROPHONE ?
        RecorderService.MIME_TYPES.audio :
        RecorderService.MIME_TYPES.video;

      const blob = new Blob(chunks, { type: mimeType });
      const duration = Date.now() - this.startTime;

      this.saveRecording({
        blob,
        type,
        startTime: this.startTime,
        duration,
      });
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

  pauseRecording() {
    if (!this.mediaRecorder || this.mediaRecorder.state !== 'recording') return;
    this.mediaRecorder.pause();
    clearInterval(this.timerInterval);
  }

  resumeRecording() {
    if (!this.mediaRecorder || this.mediaRecorder.state !== 'paused') return;
    this.mediaRecorder.resume();
    this.timerInterval = setInterval(() => {
      this.elapsedSeconds++;
      this.callbacks.updateTimer(this.elapsedSeconds);
      if (this.elapsedSeconds >= 300) { // 5 minutes
        this.callbacks.showWarning();
      }
    }, 1000);
  }

  /**
   * Handles the saved recording by passing the recording metadata back to the app.
   * @param {object} recording - The recording metadata object.
   */
  saveRecording(recording) {
    this.callbacks.onSave(recording);
  }
}
