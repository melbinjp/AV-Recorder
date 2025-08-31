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
    // Set up the DOM
    document.body.innerHTML = `
      <div class="container">
        <h1>Audio-Video Recorder</h1>
        <div class="controls">
            <button id="startMic" class="button">Start Recording Microphone</button>
            <button id="stopMic" class="button" disabled>Stop Recording Microphone</button>
            <button id="startSystem" class="button">Start Screen recording</button>
            <button id="stopSystem" class="button" disabled>Stop Screen System</button>
        </div>
        <div id="checklist" class="checklist"></div>
        <div id="log" class="log"></div>
    </div>
    `;

    // Reset mocks and instances
    jest.clearAllMocks();
    mockMediaRecorderInstances.length = 0;

    // Load the app
    await import('../src/main.js');
  });

  it('should start and stop microphone recording correctly', async () => {
    const startMicBtn = document.getElementById('startMic');
    const stopMicBtn = document.getElementById('stopMic');

    // Start recording
    startMicBtn.click();
    await new Promise(process.nextTick);

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(mockMediaRecorderInstances.length).toBe(1);
    expect(mockMediaRecorderInstances[0].start).toHaveBeenCalled();
    expect(startMicBtn.disabled).toBe(true);
    expect(stopMicBtn.disabled).toBe(false);

    // Stop recording
    stopMicBtn.click();
    await new Promise(process.nextTick);

    expect(mockMediaRecorderInstances[0].stop).toHaveBeenCalled();
    expect(startMicBtn.disabled).toBe(false);
    expect(stopMicBtn.disabled).toBe(true);
  });

  it('should start and stop system recording correctly', async () => {
    const startSystemBtn = document.getElementById('startSystem');
    const stopSystemBtn = document.getElementById('stopSystem');

    // Start recording
    startSystemBtn.click();
    await new Promise(process.nextTick);

    expect(navigator.mediaDevices.getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: true });
    expect(mockMediaRecorderInstances.length).toBe(2);
    expect(mockMediaRecorderInstances[0].start).toHaveBeenCalled();
    expect(mockMediaRecorderInstances[1].start).toHaveBeenCalled();
    expect(startSystemBtn.disabled).toBe(true);
    expect(stopSystemBtn.disabled).toBe(false);

    // Stop recording
    stopSystemBtn.click();
    await new Promise(process.nextTick);

    expect(mockMediaRecorderInstances[0].stop).toHaveBeenCalled();
    expect(mockMediaRecorderInstances[1].stop).toHaveBeenCalled();
    expect(startSystemBtn.disabled).toBe(false);
    expect(stopSystemBtn.disabled).toBe(true);
  });

  it('should start and stop screen and mic recording correctly', async () => {
    const startBtn = document.getElementById('startScreenAndMic');
    const stopBtn = document.getElementById('stopScreenAndMic');

    // Start recording
    startBtn.click();
    await new Promise(process.nextTick);

    expect(navigator.mediaDevices.getDisplayMedia).toHaveBeenCalledWith({ video: true });
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(mockMediaRecorderInstances.length).toBe(1);
    expect(mockMediaRecorderInstances[0].start).toHaveBeenCalled();
    expect(startBtn.disabled).toBe(true);
    expect(stopBtn.disabled).toBe(false);

    // Stop recording
    stopBtn.click();
    await new Promise(process.nextTick);

    expect(mockMediaRecorderInstances[0].stop).toHaveBeenCalled();
    expect(startBtn.disabled).toBe(false);
    expect(stopBtn.disabled).toBe(true);
  });
});
