/**
 * @jest-environment jsdom
 */

let mockMediaRecorderInstances = [];

beforeAll(() => {
  // Mock browser APIs
  global.MediaStream = jest.fn();
  global.URL.createObjectURL = jest.fn();
  global.URL.revokeObjectURL = jest.fn();

  global.MediaRecorder = jest.fn((stream, options) => {
    const instance = {
      start: jest.fn(),
      stop: jest.fn(),
      state: 'inactive',
      stream: { getTracks: () => [{ stop: jest.fn() }] },
      ondataavailable: null,
      onstop: null,
    };
    instance.start.mockImplementation(() => {
      instance.state = 'recording';
    });
    instance.stop.mockImplementation(() => {
      instance.state = 'inactive';
      if (instance.onstop) {
        instance.onstop();
      }
    });
    mockMediaRecorderInstances.push(instance);
    return instance;
  });

  navigator.mediaDevices = {
    getUserMedia: jest.fn().mockResolvedValue({ getTracks: () => [{ stop: jest.fn() }] }),
    getDisplayMedia: jest.fn().mockResolvedValue({
      getAudioTracks: () => [{ clone: jest.fn() }],
      getVideoTracks: () => [{ clone: jest.fn() }],
      getTracks: () => [{ stop: jest.fn() }],
    }),
  };
  navigator.permissions = {
    query: jest.fn().mockResolvedValue({ state: 'prompt' }),
  };
});

describe('App Integration Tests', () => {

  beforeEach(async () => {
    // Set up the DOM to match the new UI
    document.body.innerHTML = `
      <div class="container">
        <div class="header">
            <h1>Audio-Video Recorder</h1>
            <div class="theme-switcher">
                <button id="theme-toggle-btn" class="button theme-button">
                    <i id="theme-icon" class="fas fa-sun"></i>
                </button>
            </div>
        </div>
        <div class="controls-grid">
            <div class="card">
                <h3><i class="fas fa-microphone"></i> Microphone Recording</h3>
                <button id="startMic" class="button"><i class="fas fa-play"></i> Start Recording</button>
                <button id="stopMic" class="button" disabled><i class="fas fa-stop"></i> Stop Recording</button>
            </div>
            <div class="card">
                <h3><i class="fas fa-desktop"></i> System Recording</h3>
                <button id="startSystem" class="button"><i class="fas fa-play"></i> Start Recording</button>
                <button id="stopSystem" class="button" disabled><i class="fas fa-stop"></i> Stop Recording</button>
            </div>
            <div class="card">
                <h3><i class="fas fa-photo-video"></i> Screen & Mic Recording</h3>
                <button id="startScreenAndMic" class="button"><i class="fas fa-play"></i> Start Recording</button>
                <button id="stopScreenAndMic" class="button" disabled><i class="fas fa-stop"></i> Stop Recording</button>
            </div>
            <div class="card">
                <h3><i class="fas fa-camera"></i> Camera Recording</h3>
                <button id="startCamera" class="button"><i class="fas fa-play"></i> Start Recording</button>
                <button id="stopCamera" class="button" disabled><i class="fas fa-stop"></i> Stop Recording</button>
            </div>
        </div>
        <div class="status-container">
            <span id="status" class="status"></span>
            <span id="timer" class="timer">00:00</span>
        </div>
        <div id="checklist" class="checklist"></div>
        <div id="log" class="log"></div>
        <div id="warning" class="warning-message" style="display: none;">
            Warning: Long recordings can consume significant memory and may cause performance issues.
        </div>
    </div>
    `;

    // Reset mocks and instances
    jest.clearAllMocks();
    mockMediaRecorderInstances.length = 0;

    // Load the app
    await import('../src/main.js');
  });

  it('should start and stop microphone recording correctly', async () => {
    const startBtn = document.getElementById('startMic');
    const stopBtn = document.getElementById('stopMic');

    startBtn.click();
    await new Promise(process.nextTick);

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(mockMediaRecorderInstances.length).toBe(1);
    expect(startBtn.disabled).toBe(true);
    expect(stopBtn.disabled).toBe(false);

    stopBtn.click();
    await new Promise(process.nextTick);
    expect(startBtn.disabled).toBe(false);
    expect(stopBtn.disabled).toBe(true);
  });

  it('should start and stop system recording correctly', async () => {
    const startBtn = document.getElementById('startSystem');
    const stopBtn = document.getElementById('stopSystem');

    startBtn.click();
    await new Promise(process.nextTick);

    expect(navigator.mediaDevices.getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: true });
    expect(mockMediaRecorderInstances.length).toBe(1);
    expect(startBtn.disabled).toBe(true);
    expect(stopBtn.disabled).toBe(false);

    stopBtn.click();
    await new Promise(process.nextTick);
    expect(startBtn.disabled).toBe(false);
    expect(stopBtn.disabled).toBe(true);
  });

  it('should start and stop camera recording correctly', async () => {
    const startBtn = document.getElementById('startCamera');
    const stopBtn = document.getElementById('stopCamera');

    startBtn.click();
    await new Promise(process.nextTick);

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ video: true, audio: true });
    expect(mockMediaRecorderInstances.length).toBe(1);
    expect(startBtn.disabled).toBe(true);
    expect(stopBtn.disabled).toBe(false);

    stopBtn.click();
    await new Promise(process.nextTick);
    expect(startBtn.disabled).toBe(false);
    expect(stopBtn.disabled).toBe(true);
  });
});
