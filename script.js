class AudioRecorder {
    static MIME_TYPES = {
      audio: 'audio/webm;codecs=opus',
      video: 'video/webm;codecs=vp8,opus',
      systemAudio: 'audio/webm;codecs=opus'
    };
  
    constructor() {
      this.mediaRecorder = null;
      this.systemAudioRecorder = null;
      this.audioChunks = [];
      this.videoChunks = [];
      this.systemAudioChunks = [];
      this.isRecording = false;
      this.startTime = 0;
      this.duration = 0;
      this.checklistItems = [
        'Grant microphone permissions',
        'Test microphone',
        'Grant system audio/video permissions',
        'Test system recording'
      ];
      
      this.initializeElements();
      this.setupEventListeners();
      this.renderChecklist();
      this.setupAudioCapabilities();
    }
  
    initializeElements() {
      this.startMicBtn = document.getElementById('startMic');
      this.stopMicBtn = document.getElementById('stopMic');
      this.startSystemBtn = document.getElementById('startSystem');
      this.stopSystemBtn = document.getElementById('stopSystem');
      this.logDiv = document.getElementById('log');
      this.checklistDiv = document.getElementById('checklist');
      
      this.stopMicBtn.disabled = true;
      this.stopSystemBtn.disabled = true;
    }
  
    setupEventListeners() {
      this.startMicBtn.addEventListener('click', () => this.startRecording('microphone'));
      this.stopMicBtn.addEventListener('click', () => this.stopRecording('microphone'));
      this.startSystemBtn.addEventListener('click', () => this.startRecording('system'));
      this.stopSystemBtn.addEventListener('click', () => this.stopRecording('system'));
    }
  
    renderChecklist() {
      this.checklistDiv.innerHTML = this.checklistItems
        .map((item, index) => `
          <div class="checklist-item" id="checklist-${index}">
            <input type="checkbox" disabled>
            <span>${item}</span>
          </div>
        `).join('');
    }
  
    async setupAudioCapabilities() {
      try {
        const permission = await navigator.permissions.query({ name: 'microphone' });
        if (permission.state === 'granted') {
          this.updateChecklist(0, true);
        }
      } catch (error) {
        this.logError('Failed to setup audio capabilities: ' + error.message);
      }
    }
  
    async startRecording(type) {
      try {
        let stream;
        if (type === 'microphone') {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          this.updateChecklist(1, true);
        } else {
          const displayStream = await navigator.mediaDevices.getDisplayMedia({ 
            video: true,
            audio: true 
          });
          
          const audioTrack = displayStream.getAudioTracks()[0];
          if (audioTrack) {
            const systemAudioStream = new MediaStream([audioTrack.clone()]);
            this.systemAudioRecorder = new MediaRecorder(systemAudioStream, {
              mimeType: AudioRecorder.MIME_TYPES.systemAudio
            });
            
            this.systemAudioRecorder.ondataavailable = (event) => {
              if (event.data.size > 0) {
                this.systemAudioChunks.push(event.data);
              }
            };
  
            this.systemAudioRecorder.onstop = () => {
              const blob = new Blob(this.systemAudioChunks, { 
                type: AudioRecorder.MIME_TYPES.systemAudio 
              });
              this.saveRecording(blob, 'system-audio');
              this.systemAudioChunks = [];
            };
            
            this.systemAudioRecorder.start();
            this.updateChecklist(2, true);
          }
          
          stream = displayStream;
          this.updateChecklist(3, true);
        }
  
        this.startTime = Date.now();
        this.mediaRecorder = new MediaRecorder(stream, {
          mimeType: type === 'microphone' ? 
            AudioRecorder.MIME_TYPES.audio : 
            AudioRecorder.MIME_TYPES.video
        });
  
        this.setupRecordingHandlers(type);
        this.mediaRecorder.start();
        this.updateUI(true, type);
        this.isRecording = true;
        
      } catch (error) {
        this.logError(`Recording failed: ${error.message}`);
      }
    }
  
    setupRecordingHandlers(type) {
      const chunks = type === 'microphone' ? this.audioChunks : this.videoChunks;
      
      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data);
        }
      };
  
      this.mediaRecorder.onstop = () => {
        const mimeType = type === 'microphone' ? 
          AudioRecorder.MIME_TYPES.audio : 
          AudioRecorder.MIME_TYPES.video;
          
        const blob = new Blob(chunks, { type: mimeType });
        this.saveRecording(blob, type);
        chunks.length = 0;
      };
    }
  
    stopRecording(type) {
      if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') return;
  
      this.mediaRecorder.stop();
      this.mediaRecorder.stream.getTracks().forEach(track => track.stop());
      
      if (this.systemAudioRecorder && this.systemAudioRecorder.state === 'recording') {
        this.systemAudioRecorder.stop();
      }
      
      this.updateUI(false, type);
      this.isRecording = false;
    }
  
    saveRecording(blob, type) {
      this.duration = (Date.now() - this.startTime) / 1000;
      
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
  
    updateUI(isRecording, type) {
      if (type === 'microphone') {
        this.startMicBtn.disabled = isRecording;
        this.stopMicBtn.disabled = !isRecording;
      } else {
        this.startSystemBtn.disabled = isRecording;
        this.stopSystemBtn.disabled = !isRecording;
      }
    }
  
    updateChecklist(index, completed) {
      const checklistItem = document.getElementById(`checklist-${index}`);
      if (checklistItem) {
        const checkbox = checklistItem.querySelector('input[type="checkbox"]');
        checkbox.checked = completed;
        checklistItem.classList.toggle('completed', completed);
      }
    }
  
    logMessage(message) {
      const logEntry = document.createElement('div');
      logEntry.textContent = `${new Date().toLocaleTimeString()}: ${message}`;
      this.logDiv.appendChild(logEntry);
      this.logDiv.scrollTop = this.logDiv.scrollHeight;
    }
  
    logError(message) {
      const errorEntry = document.createElement('div');
      errorEntry.className = 'error-message';
      errorEntry.textContent = `${new Date().toLocaleTimeString()}: Error - ${message}`;
      this.logDiv.appendChild(errorEntry);
      this.logDiv.scrollTop = this.logDiv.scrollHeight;
    }
  }
  
  document.addEventListener('DOMContentLoaded', () => {
    new AudioRecorder();
  });
  