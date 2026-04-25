class MediaApp {
    constructor() {
        // State
        this.stream = null;
        this.mediaRecorder = null;
        this.recordedChunks = [];
        this.recordedBlob = null;
        
        this.recordingType = null; // 'audio', 'camera', 'screen'
        this.isRecording = false;
        this.isPaused = false;
        this.startTime = 0;
        this.pausedTime = 0;
        this.timerInterval = null;
        
        // Audio Visualizer
        this.audioContext = null;
        this.analyser = null;
        this.animationFrameId = null;

        // Elements
        this.videoSource = document.getElementById('videoSource');
        this.audioSource = document.getElementById('audioSource');
        this.mirrorCamera = document.getElementById('mirrorCamera');
        
        this.liveVideo = document.getElementById('liveVideo');
        this.audioVisualizer = document.getElementById('audioVisualizer');
        this.previewPlaceholder = document.getElementById('previewPlaceholder');
        
        this.startBtns = document.querySelectorAll('.start-btn');
        this.pauseBtn = document.getElementById('pauseBtn');
        this.stopBtn = document.getElementById('stopBtn');
        this.discardBtn = document.getElementById('discardBtn');
        this.downloadBtn = document.getElementById('downloadBtn');
        
        this.activeControls = document.getElementById('activeControls');
        this.playbackControls = document.getElementById('playbackControls');
        
        this.recordingStatus = document.getElementById('recordingStatus');
        this.statusText = this.recordingStatus.querySelector('.status-text');
        this.recordingTime = document.getElementById('recordingTime');
        this.toastContainer = document.getElementById('toastContainer');

        this.init();
    }

    async init() {
        this.setupEventListeners();
        await this.populateDeviceList();
        
        // Listen for device changes
        navigator.mediaDevices.addEventListener('devicechange', () => {
            this.populateDeviceList();
        });
        
        // Initial visualizer setup
        this.resizeCanvas();
        window.addEventListener('resize', () => this.resizeCanvas());
    }

    setupEventListeners() {
        this.startBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const type = btn.dataset.type;
                this.startRecordingMode(type);
            });
        });

        this.pauseBtn.addEventListener('click', () => this.togglePause());
        this.stopBtn.addEventListener('click', () => this.stopRecording());
        this.discardBtn.addEventListener('click', () => this.discardRecording());
        this.downloadBtn.addEventListener('click', () => this.downloadRecording());
        
        this.videoSource.addEventListener('change', () => {
            if (this.stream && this.recordingType === 'camera' && !this.isRecording) {
                this.previewCamera();
            }
        });
        
        this.audioSource.addEventListener('change', () => {
            if (this.stream && (this.recordingType === 'camera' || this.recordingType === 'audio') && !this.isRecording) {
                 if (this.recordingType === 'camera') this.previewCamera();
                 if (this.recordingType === 'audio') this.previewAudio();
            }
        });
        
        this.mirrorCamera.addEventListener('change', () => {
            this.updateMirrorState();
        });
    }
    
    updateMirrorState() {
        if (this.mirrorCamera.checked && this.recordingType === 'camera') {
            this.liveVideo.classList.add('mirror-video');
        } else {
            this.liveVideo.classList.remove('mirror-video');
        }
    }

    async populateDeviceList() {
        try {
            // Request minimal permissions to trigger device enumeration labels in some browsers
            await navigator.mediaDevices.getUserMedia({ audio: true, video: true }).then(stream => {
                stream.getTracks().forEach(track => track.stop());
            }).catch(err => {
                console.warn("Initial permission request failed. Labels might be hidden.", err);
            });

            const devices = await navigator.mediaDevices.enumerateDevices();
            
            this.videoSource.innerHTML = '';
            this.audioSource.innerHTML = '';
            
            let videoCount = 1;
            let audioCount = 1;

            devices.forEach(device => {
                const option = document.createElement('option');
                option.value = device.deviceId;
                
                if (device.kind === 'videoinput') {
                    option.text = device.label || `Camera ${videoCount++}`;
                    this.videoSource.appendChild(option);
                } else if (device.kind === 'audioinput') {
                    option.text = device.label || `Microphone ${audioCount++}`;
                    this.audioSource.appendChild(option);
                }
            });

            if (this.videoSource.options.length === 0) {
                this.videoSource.innerHTML = '<option value="">No Camera Found</option>';
            }
            if (this.audioSource.options.length === 0) {
                this.audioSource.innerHTML = '<option value="">No Microphone Found</option>';
            }
        } catch (err) {
            this.showToast("Error enumerating devices.", "error");
            console.error(err);
        }
    }

    async startRecordingMode(type) {
        this.discardRecording(); // Clean up previous
        this.recordingType = type;
        this.updateMirrorState();
        
        try {
            if (type === 'audio') {
                await this.previewAudio();
            } else if (type === 'camera') {
                await this.previewCamera();
            } else if (type === 'screen') {
                await this.previewScreen();
            }
            
            if (this.stream) {
                this.startRecording();
            }
        } catch (err) {
            this.showToast(`Failed to start ${type} capture: ${err.message}`, "error");
            console.error(err);
        }
    }

    async previewAudio() {
        const audioId = this.audioSource.value;
        const constraints = {
            audio: audioId ? { deviceId: { exact: audioId } } : true,
            video: false
        };
        
        this.stream = await navigator.mediaDevices.getUserMedia(constraints);
        this.setupLivePreview(false); // Audio only
    }

    async previewCamera() {
        const videoId = this.videoSource.value;
        const audioId = this.audioSource.value;
        
        const constraints = {
            audio: audioId ? { deviceId: { exact: audioId } } : true,
            video: videoId ? { deviceId: { exact: videoId } } : true
        };
        
        this.stream = await navigator.mediaDevices.getUserMedia(constraints);
        this.setupLivePreview(true);
    }

    async previewScreen() {
        const audioId = this.audioSource.value;
        
        // DisplayMedia for screen
        const displayStream = await navigator.mediaDevices.getDisplayMedia({
            video: { cursor: "always" },
            audio: true // System audio
        });
        
        // Optional: Mix in microphone
        try {
            const micStream = await navigator.mediaDevices.getUserMedia({
                audio: audioId ? { deviceId: { exact: audioId } } : true
            });
            
            // Mix audio tracks
            this.stream = new MediaStream([
                ...displayStream.getVideoTracks(),
                ...displayStream.getAudioTracks(),
                ...micStream.getAudioTracks()
            ]);
            
            // Handle display stream stopping
            displayStream.getVideoTracks()[0].onended = () => {
                if (this.isRecording) this.stopRecording();
            };
            
        } catch(err) {
            // If mic fails, just use display stream
            this.showToast("Screen recording started without microphone.", "warning");
            this.stream = displayStream;
        }
        
        this.setupLivePreview(true);
    }

    setupLivePreview(hasVideo) {
        this.previewPlaceholder.style.display = 'none';
        this.audioVisualizer.parentElement.style.display = 'block';
        
        if (hasVideo) {
            this.liveVideo.style.display = 'block';
            this.liveVideo.srcObject = this.stream;
            this.liveVideo.controls = false;
        } else {
            this.liveVideo.style.display = 'none';
        }
        
        this.setupVisualizer(this.stream);
    }

    setupVisualizer(stream) {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        
        // Check if stream has audio tracks
        if (stream.getAudioTracks().length === 0) return;

        if (this.audioContext.state === 'suspended') {
            this.audioContext.resume();
        }

        const source = this.audioContext.createMediaStreamSource(stream);
        this.analyser = this.audioContext.createAnalyser();
        this.analyser.fftSize = 256;
        source.connect(this.analyser);
        
        this.drawVisualizer();
    }

    drawVisualizer() {
        if (!this.analyser) return;
        
        const canvas = this.audioVisualizer;
        const ctx = canvas.getContext('2d');
        const bufferLength = this.analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        
        const draw = () => {
            this.animationFrameId = requestAnimationFrame(draw);
            this.analyser.getByteFrequencyData(dataArray);
            
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            
            const barWidth = (canvas.width / bufferLength) * 2.5;
            let barHeight;
            let x = 0;
            
            for(let i = 0; i < bufferLength; i++) {
                barHeight = (dataArray[i] / 255) * canvas.height;
                
                // Color gradient based on frequency
                const r = barHeight + (25 * (i/bufferLength));
                const g = 250 * (i/bufferLength);
                const b = 50;
                
                ctx.fillStyle = `rgba(${r},${g},${b}, 0.7)`;
                ctx.fillRect(x, 0, barWidth, barHeight);
                
                x += barWidth + 1;
            }
        };
        
        draw();
    }

    resizeCanvas() {
        const container = this.audioVisualizer.parentElement;
        this.audioVisualizer.width = container.clientWidth;
        this.audioVisualizer.height = container.clientHeight;
    }

    startRecording() {
        this.recordedChunks = [];
        
        let mimeType = 'video/webm;codecs=vp8,opus';
        if (this.recordingType === 'audio') {
            mimeType = 'audio/webm;codecs=opus';
        }
        
        if (!MediaRecorder.isTypeSupported(mimeType)) {
            mimeType = this.recordingType === 'audio' ? 'audio/webm' : 'video/webm';
        }

        try {
            this.mediaRecorder = new MediaRecorder(this.stream, { mimeType });
            
            this.mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) this.recordedChunks.push(e.data);
            };
            
            this.mediaRecorder.onstop = () => this.handleRecordingStop();
            
            this.mediaRecorder.start(100); // collect 100ms chunks
            
            this.isRecording = true;
            this.isPaused = false;
            this.startTime = Date.now();
            this.startTimer();
            
            this.updateUIState();
            this.showToast(`Started ${this.recordingType} recording`, "success");
            
        } catch (err) {
            this.showToast(`Error starting recorder: ${err.message}`, "error");
        }
    }

    togglePause() {
        if (!this.mediaRecorder) return;
        
        if (this.isPaused) {
            this.mediaRecorder.resume();
            this.isPaused = false;
            this.startTime += (Date.now() - this.pausedTime);
            this.startTimer();
            this.showToast("Recording resumed", "success");
        } else {
            this.mediaRecorder.pause();
            this.isPaused = true;
            this.pausedTime = Date.now();
            clearInterval(this.timerInterval);
            this.showToast("Recording paused", "warning");
        }
        this.updateUIState();
    }

    stopRecording() {
        if (this.mediaRecorder && this.isRecording) {
            this.mediaRecorder.stop();
            // Tracks are stopped in handleRecordingStop to allow MediaRecorder to finish processing
        }
    }

    handleRecordingStop() {
        this.isRecording = false;
        this.isPaused = false;
        clearInterval(this.timerInterval);
        
        // Stop all tracks
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
        }
        
        if (this.animationFrameId) {
            cancelAnimationFrame(this.animationFrameId);
        }
        
        const mimeType = this.recordingType === 'audio' ? 'audio/webm' : 'video/webm';
        this.recordedBlob = new Blob(this.recordedChunks, { type: mimeType });
        
        // Set up playback
        const url = URL.createObjectURL(this.recordedBlob);
        this.liveVideo.srcObject = null;
        this.liveVideo.src = url;
        this.liveVideo.controls = true;
        this.liveVideo.style.display = 'block';
        this.audioVisualizer.parentElement.style.display = 'none';
        
        this.updateUIState();
        this.showToast("Recording finished. You can now preview or download.", "success");
    }

    discardRecording() {
        if (this.isRecording) this.stopRecording();
        
        if (this.liveVideo.src) {
            URL.revokeObjectURL(this.liveVideo.src);
            this.liveVideo.src = "";
            this.liveVideo.controls = false;
        }
        
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
            this.stream = null;
        }
        
        this.liveVideo.style.display = 'none';
        this.previewPlaceholder.style.display = 'flex';
        this.audioVisualizer.parentElement.style.display = 'none';
        
        const canvas = this.audioVisualizer;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        this.recordedBlob = null;
        this.recordedChunks = [];
        this.recordingTime.textContent = '00:00';
        this.recordingType = null;
        
        this.updateUIState();
    }

    downloadRecording() {
        if (!this.recordedBlob) return;
        
        const ext = this.recordingType === 'audio' ? 'webm' : 'webm';
        const filename = `${this.recordingType}-recording-${new Date().toISOString().slice(0,10).replace(/-/g,"")}.${ext}`;
        
        const url = URL.createObjectURL(this.recordedBlob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = filename;
        
        document.body.appendChild(a);
        a.click();
        
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);
        
        this.showToast(`Downloaded ${filename}`, "success");
    }

    startTimer() {
        clearInterval(this.timerInterval);
        this.timerInterval = setInterval(() => {
            const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
            const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
            const secs = (elapsed % 60).toString().padStart(2, '0');
            this.recordingTime.textContent = `${mins}:${secs}`;
        }, 1000);
    }

    updateUIState() {
        // Active Cards styling
        document.querySelectorAll('.action-card').forEach(card => card.classList.remove('active'));
        if (this.isRecording || this.recordedBlob) {
            const activeCard = document.getElementById(`card-${this.recordingType}`);
            if (activeCard) activeCard.classList.add('active');
        }

        // Start Buttons
        this.startBtns.forEach(btn => {
            btn.disabled = this.isRecording || this.recordedBlob !== null;
        });

        // Controls visibility
        this.activeControls.style.display = this.isRecording ? 'flex' : 'none';
        this.playbackControls.style.display = (!this.isRecording && this.recordedBlob) ? 'flex' : 'none';
        
        // Pause Button text
        if (this.isPaused) {
            this.pauseBtn.innerHTML = '<i class="ph-fill ph-play"></i> Resume';
            this.pauseBtn.className = 'btn btn-success';
        } else {
            this.pauseBtn.innerHTML = '<i class="ph-fill ph-pause"></i> Pause';
            this.pauseBtn.className = 'btn btn-warning';
        }

        // Status Indicator
        this.recordingStatus.className = 'status-indicator';
        if (this.isRecording) {
            if (this.isPaused) {
                this.recordingStatus.classList.add('paused');
                this.statusText.textContent = 'Paused';
            } else {
                this.recordingStatus.classList.add('recording');
                this.statusText.textContent = 'Recording';
            }
        } else if (this.recordedBlob) {
            this.statusText.textContent = 'Playback Mode';
        } else {
            this.statusText.textContent = 'Ready';
        }
    }

    showToast(message, type = "info") {
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        
        let icon = 'info';
        if (type === 'success') icon = 'check-circle';
        if (type === 'error') icon = 'warning-circle';
        if (type === 'warning') icon = 'warning';
        
        toast.innerHTML = `<i class="ph-fill ph-${icon}"></i> <span>${message}</span>`;
        this.toastContainer.appendChild(toast);
        
        // Trigger reflow for transition
        void toast.offsetWidth;
        toast.classList.add('show');
        
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.app = new MediaApp();
});