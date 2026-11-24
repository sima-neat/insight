import {
  captureModeIdsWithin,
  CAPTURE_MODES,
  effectiveCaptureMode,
  keepWebcamResolution,
  offeredCaptureModes,
  webcamBitrateKbps,
  webcamCaptureConstraints,
  withWebcamBitrate,
} from './webcam-capture';

// The tests of `webcamPublishing.test.js` in sima-neat/insight#248, over the modes this port
// offers: Insight's normalizer publishes every webcam at 30 fps, so no mode asks for more.

/** Every mode, largest first: what a camera that reports no limits is offered. */
const ALL_MODES = ['2160p30', '1440p30', '1080p30', '720p30', '480p30', 'camera'];

const limits = (width: number, height: number, frameRate: number) => ({
  width: { min: 1, max: width },
  height: { min: 1, max: height },
  frameRate: { min: 1, max: frameRate },
});

describe('the capture modes', () => {
  it('are listed largest first, every one at 30 fps, with the camera default last', () => {
    expect(CAPTURE_MODES.map((mode) => mode.id)).toEqual(ALL_MODES);
    expect(CAPTURE_MODES.find((mode) => mode.id === '1080p30')?.label).toBe('1920x1080 at 30 fps');
    expect(CAPTURE_MODES.filter((mode) => mode.frameRate).every((m) => m.frameRate === 30)).toBe(
      true,
    );
  });

  it('a camera is offered only the modes within its largest reported size and rate', () => {
    expect(captureModeIdsWithin(limits(3840, 2160, 60))).toEqual(ALL_MODES);
    expect(captureModeIdsWithin(limits(1920, 1080, 30))).toEqual([
      '1080p30',
      '720p30',
      '480p30',
      'camera',
    ]);
    expect(captureModeIdsWithin(limits(1280, 720, 60))).toEqual(['720p30', '480p30', 'camera']);
    expect(captureModeIdsWithin(limits(1920, 1080, 15))).toEqual(['camera']);
  });

  it('read a reported 29.97 fps maximum as 30, as NTSC cameras report it', () => {
    expect(captureModeIdsWithin(limits(1920, 1080, 29.97))).toEqual([
      '1080p30',
      '720p30',
      '480p30',
      'camera',
    ]);
  });

  it('are all offered when the browser reports no limits (Firefox, Safari, Chrome before permission)', () => {
    expect(captureModeIdsWithin(undefined)).toEqual(ALL_MODES);
    expect(captureModeIdsWithin({})).toEqual(ALL_MODES);
  });

  it('are offered as the modes of the ids a camera reaches, all of them for a camera with none given', () => {
    expect(offeredCaptureModes(['720p30', 'camera']).map((mode) => mode.id)).toEqual([
      '720p30',
      'camera',
    ]);
    expect(offeredCaptureModes(undefined).map((mode) => mode.id)).toEqual(ALL_MODES);
  });

  it('show the chosen mode when the camera reaches it, else the largest it does', () => {
    expect(effectiveCaptureMode('720p30', undefined)).toBe('720p30');
    expect(effectiveCaptureMode('720p30', ['720p30', 'camera'])).toBe('720p30');
    expect(effectiveCaptureMode('1080p30', ['720p30', 'camera'])).toBe('720p30');
    expect(effectiveCaptureMode('unknown', ['480p30', 'camera'])).toBe('480p30');
  });
});

describe('webcamCaptureConstraints', () => {
  const device = { deviceId: { exact: 'cam1' } };

  it('asks for 1920x1080 at 30 fps unless another mode is chosen, and for an unknown mode', () => {
    const ideal = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
    expect(webcamCaptureConstraints('cam1')).toEqual({ video: { ...device, ...ideal } });
    expect(webcamCaptureConstraints('cam1', 'unknown')).toEqual({ video: { ...device, ...ideal } });
  });

  it('asks for the chosen size as ideal, so a camera without it falls back to its nearest', () => {
    expect(webcamCaptureConstraints('cam1', '720p30')).toEqual({
      video: {
        ...device,
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
      },
    });
  });

  it('asks for the device alone for the camera default', () => {
    expect(webcamCaptureConstraints('cam1', 'camera')).toEqual({ video: device });
  });
});

describe('webcamBitrateKbps', () => {
  it('sends Auto at about 0.13 bits per pixel of the mode', () => {
    expect(webcamBitrateKbps()).toBe(8087);
    expect(webcamBitrateKbps('auto', '720p30')).toBe(3594);
    expect(webcamBitrateKbps('auto', '2160p30')).toBe(32348);
  });

  it("takes the default mode's rate for the camera default or an unknown mode", () => {
    expect(webcamBitrateKbps('auto', 'camera')).toBe(8087);
    expect(webcamBitrateKbps('auto', 'unknown')).toBe(8087);
  });

  it('sends a fixed choice at its rate, and an unknown choice as Auto', () => {
    expect(webcamBitrateKbps('4mbps', '2160p30')).toBe(4000);
    expect(webcamBitrateKbps('unknown', '720p30')).toBe(3594);
  });
});

describe('keepWebcamResolution', () => {
  it("keeps the camera's size under short bandwidth and lets the sender reach the bitrate", async () => {
    const setParameters = vi.fn(async () => undefined);
    const sender = {
      getParameters: () => ({ transactionId: 't1', encodings: [{ active: true }] }),
      setParameters,
    };

    await keepWebcamResolution(sender, 3594);

    expect(setParameters).toHaveBeenCalledExactlyOnceWith({
      transactionId: 't1',
      degradationPreference: 'maintain-resolution',
      encodings: [{ active: true, maxBitrate: 3594000 }],
    });
  });

  it('lets a browser that refuses the settings publish with its own, and says so on the console', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sender = {
      getParameters: () => ({ encodings: [{}] }),
      setParameters: async () => {
        throw new Error('InvalidModificationError');
      },
    };

    await expect(keepWebcamResolution(sender, 8087)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe('withWebcamBitrate', () => {
  it("starts the answer's H.264 formats at the bitrate and leaves the other formats alone", () => {
    const answer = [
      'm=video 9 UDP/TLS/RTP/SAVPF 96 97',
      'a=rtpmap:96 H264/90000',
      'a=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
      'a=rtpmap:97 rtx/90000',
      'a=fmtp:97 apt=96',
      '',
    ].join('\r\n');

    expect(withWebcamBitrate(answer, 8087)).toBe(
      [
        'm=video 9 UDP/TLS/RTP/SAVPF 96 97',
        'a=rtpmap:96 H264/90000',
        'a=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f;x-google-start-bitrate=8087;x-google-min-bitrate=4044',
        'a=rtpmap:97 rtx/90000',
        'a=fmtp:97 apt=96',
        '',
      ].join('\r\n'),
    );
  });
});
