export class DeviceManager {
  async getDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      console.log("enumerateDevices() not supported.");
      return { audio: [], video: [] };
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioDevices = devices.filter(device => device.kind === 'audioinput');
    const videoDevices = devices.filter(device => device.kind === 'videoinput');

    return { audio: audioDevices, video: videoDevices };
  }
}
