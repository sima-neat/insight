import { browserCameraMedia } from './camera-media';

/** The part of `MediaDevices` the browser seam touches. */
function fakeMediaDevices() {
  const listeners = new Set<() => void>();
  const devices = {
    getUserMedia: vi.fn(async () => ({ id: 'stream' })),
    enumerateDevices: vi.fn(async () => [{ kind: 'videoinput', deviceId: 'a', label: 'A' }]),
    addEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === 'devicechange') listeners.add(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === 'devicechange') listeners.delete(listener);
    }),
  };
  return { devices: devices as unknown as MediaDevices, mock: devices, listeners };
}

describe('browserCameraMedia', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('can capture only where the browser offers both opening and listing devices', () => {
    expect(browserCameraMedia(fakeMediaDevices().devices).canCapture).toBe(true);
    // An insecure page has no `navigator.mediaDevices` at all.
    expect(browserCameraMedia(undefined).canCapture).toBe(false);
    expect(browserCameraMedia({} as MediaDevices).canCapture).toBe(false);
  });

  it('opens and lists through the browser', async () => {
    const { devices, mock } = fakeMediaDevices();
    const media = browserCameraMedia(devices);

    await expect(media.getUserMedia({ video: true })).resolves.toEqual({ id: 'stream' });
    expect(mock.getUserMedia).toHaveBeenCalledWith({ video: true });
    await expect(media.enumerateDevices()).resolves.toEqual([
      { kind: 'videoinput', deviceId: 'a', label: 'A' },
    ]);
  });

  it('listens for devicechange until told to stop', () => {
    const { devices, listeners } = fakeMediaDevices();
    const listener = vi.fn();

    const stop = browserCameraMedia(devices).onDeviceChange(listener);
    expect([...listeners]).toEqual([listener]);

    stop();
    expect(listeners.size).toBe(0);
  });

  it('rejects, rather than throwing out of a call, where capture is missing', async () => {
    const media = browserCameraMedia(undefined);

    await expect(media.getUserMedia({ video: true })).rejects.toThrow(
      'This browser cannot access cameras.',
    );
    await expect(media.enumerateDevices()).rejects.toThrow('This browser cannot access cameras.');
  });

  it('reports no video capabilities in a browser that cannot tell, so publishing refuses with the H.264 message', () => {
    vi.stubGlobal('RTCRtpSender', {});

    expect(browserCameraMedia(undefined).videoCapabilities()).toBe(null);
  });

  it('creates peer connections and reads the video capabilities from the browser globals', () => {
    class FakePeerConnection {}
    const getCapabilities = vi.fn(() => ({
      codecs: [{ mimeType: 'video/H264' }],
      headerExtensions: [],
    }));
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
    vi.stubGlobal('RTCRtpSender', { getCapabilities });
    const media = browserCameraMedia(undefined);

    expect(media.createPeer()).toBeInstanceOf(FakePeerConnection);
    expect(media.videoCapabilities()?.codecs).toEqual([{ mimeType: 'video/H264' }]);
    expect(getCapabilities).toHaveBeenCalledWith('video');
  });
});
