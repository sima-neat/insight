/**
 * What a webcam source asks of its camera and of the browser's sender, ported from
 * `webcamPublishing.js` in sima-neat/insight#248: the capture mode (size and rate), the bitrate,
 * and the settings that keep the size when bandwidth runs short. Plain functions over narrow
 * structural types, so they are tested without a camera or a peer connection;
 * `CamerasService` applies them.
 *
 * **Every mode is at 30 fps, deliberately.** Upstream also offers 1080p60 and 720p60, but
 * MediaMTX's normalizer (`webrtc/mediamtx.yml`) re-encodes every webcam at a fixed `-r 30`, which
 * it needs for the encoder to state an H.264 level the board's decoder accepts. A 60 fps capture
 * would reach the stream URL at 30 fps, so the list does not offer what the stream cannot carry.
 * The size passes through unchanged.
 */

/** A size and rate a webcam source can ask its camera for. */
export interface CaptureMode {
  readonly id: string;
  readonly label: string;
  /** Absent for the camera default, which asks for no size at all. */
  readonly width?: number;
  readonly height?: number;
  readonly frameRate?: number;
}

const mode = (width: number, height: number, frameRate: number): CaptureMode => ({
  id: `${height}p${frameRate}`,
  label: `${width}x${height} at ${frameRate} fps`,
  width,
  height,
  frameRate,
});

/**
 * The capture modes, largest first. Each size and rate is requested as `ideal`, so a camera
 * without that mode sends its nearest one instead of failing to start.
 */
export const CAPTURE_MODES: readonly CaptureMode[] = [
  mode(3840, 2160, 30),
  mode(2560, 1440, 30),
  mode(1920, 1080, 30),
  mode(1280, 720, 30),
  mode(640, 480, 30),
  { id: 'camera', label: 'Camera default' },
];

export const DEFAULT_CAPTURE_MODE = '1080p30';

/** A camera's largest size and rate, as Chrome's `InputDeviceInfo.getCapabilities()` reports them. */
export interface CaptureLimits {
  readonly width?: { readonly max?: number };
  readonly height?: { readonly max?: number };
  readonly frameRate?: { readonly max?: number };
}

/**
 * The ids of the modes within a camera's largest size and rate. The browser reports only those
 * maxima, not which sizes the camera delivers at which rates, so a listed mode can still fall back
 * to a nearer one. Without a report, as in Firefox and Safari, every mode is listed.
 */
export function captureModeIdsWithin(limits: CaptureLimits | null | undefined): string[] {
  // Rounded, because cameras report NTSC rates such as 29.97 for a 30 fps mode.
  const within = (value: number, max: number | undefined) =>
    max === undefined || !(Math.round(max) < value);
  return CAPTURE_MODES.filter(
    (candidate) =>
      !candidate.width ||
      (within(candidate.width, limits?.width?.max) &&
        within(candidate.height ?? 0, limits?.height?.max) &&
        within(candidate.frameRate ?? 0, limits?.frameRate?.max)),
  ).map((candidate) => candidate.id);
}

/** The modes a camera is offered, from the ids it reaches; every mode while they are not known. */
export function offeredCaptureModes(ids: readonly string[] | undefined): CaptureMode[] {
  return CAPTURE_MODES.filter((candidate) => !ids || ids.includes(candidate.id));
}

/**
 * The mode a slot publishes in: the chosen one while the camera reaches it, else the largest the
 * camera does, which is what its list shows.
 */
export function effectiveCaptureMode(chosen: string, ids: readonly string[] | undefined): string {
  const offered = offeredCaptureModes(ids);
  return offered.some((candidate) => candidate.id === chosen) ? chosen : offered[0].id;
}

/** The `getUserMedia` constraints that open a camera in a mode; an unknown mode is the default. */
export function webcamCaptureConstraints(
  deviceId: string,
  modeId: string = DEFAULT_CAPTURE_MODE,
): MediaStreamConstraints {
  const chosen =
    CAPTURE_MODES.find((candidate) => candidate.id === modeId) ??
    CAPTURE_MODES.find((candidate) => candidate.id === DEFAULT_CAPTURE_MODE)!;
  const video: MediaTrackConstraints = { deviceId: { exact: deviceId } };
  if (chosen.width) {
    video.width = { ideal: chosen.width };
    video.height = { ideal: chosen.height };
    video.frameRate = { ideal: chosen.frameRate };
  }
  return { video };
}

/** A bitrate a webcam can be sent at: Auto, which follows the mode, or a fixed rate. */
export interface WebcamBitrate {
  readonly id: string;
  readonly label: string;
  /** Absent for Auto. */
  readonly kbps?: number;
}

/**
 * The bitrates a webcam can be sent at. Auto is about 0.13 bits per pixel of the mode: 8087 kbps
 * at 1080p30. Chrome's defaults start a stream at a few hundred kbps and lower the size to fit it,
 * so a camera opened at 1920x1080 reached MediaMTX at 320x180.
 */
export const WEBCAM_BITRATES: readonly WebcamBitrate[] = [
  { id: 'auto', label: 'Auto' },
  ...[2, 4, 8, 16, 32].map((mbps) => ({
    id: `${mbps}mbps`,
    label: `${mbps} Mbps`,
    kbps: mbps * 1000,
  })),
];

export const DEFAULT_WEBCAM_BITRATE = 'auto';

/**
 * The bitrate in kbps for a bitrate choice and a mode. Auto for the camera default, or for an
 * unknown mode or choice, takes the default mode's rate.
 */
export function webcamBitrateKbps(
  bitrateId: string = DEFAULT_WEBCAM_BITRATE,
  modeId: string = DEFAULT_CAPTURE_MODE,
): number {
  const fixed = WEBCAM_BITRATES.find((bitrate) => bitrate.id === bitrateId)?.kbps;
  if (fixed) return fixed;
  const sized =
    CAPTURE_MODES.find((candidate) => candidate.id === modeId && candidate.width) ??
    CAPTURE_MODES.find((candidate) => candidate.id === DEFAULT_CAPTURE_MODE)!;
  return Math.round(
    ((sized.width ?? 0) * (sized.height ?? 0) * (sized.frameRate ?? 0) * 0.13) / 1000,
  );
}

/** The part of an `RTCRtpSendParameters` that `keepWebcamResolution` sets. */
export interface TunableParameters {
  degradationPreference?: RTCDegradationPreference;
  encodings?: { active?: boolean; maxBitrate?: number }[];
}

/** The part of an `RTCRtpSender` that `keepWebcamResolution` drives. */
export interface TunableSender {
  getParameters(): TunableParameters;
  setParameters(parameters: TunableParameters): Promise<void>;
}

/**
 * Keeps the camera's size when the bandwidth runs short, lowering the frame rate instead, and lets
 * the sender reach `kbps`. Applied after the answer, when the sender has its encoding. A browser
 * that refuses the settings still publishes, with its own defaults and a console warning.
 */
export async function keepWebcamResolution(sender: TunableSender, kbps: number): Promise<void> {
  try {
    const parameters = sender.getParameters();
    parameters.degradationPreference = 'maintain-resolution';
    for (const encoding of parameters.encodings ?? []) encoding.maxBitrate = kbps * 1000;
    await sender.setParameters(parameters);
  } catch (failure) {
    console.warn('The browser kept its own webcam bitrate and size settings:', failure);
  }
}

/**
 * Adds Chrome's start and minimum bitrate to the H.264 formats of MediaMTX's answer, so the stream
 * starts at `kbps` instead of climbing from a few hundred kbps. Other browsers ignore them.
 */
export function withWebcamBitrate(answerSdp: string, kbps: number): string {
  const hints = `x-google-start-bitrate=${kbps};x-google-min-bitrate=${Math.round(kbps / 2)}`;
  const h264Payloads = new Set(
    [...answerSdp.matchAll(/^a=rtpmap:(\d+) H264\/90000/gim)].map((match) => match[1]),
  );
  return answerSdp.replace(/^a=fmtp:(\d+) (.*)$/gm, (line, payload: string, formats: string) =>
    h264Payloads.has(payload) ? `a=fmtp:${payload} ${formats.trimEnd()};${hints}` : line,
  );
}

/** What a slot's webcam publishes with: a mode's id and a bitrate's id. */
export interface WebcamCapture {
  readonly mode: string;
  readonly bitrate: string;
}

export const DEFAULT_WEBCAM_CAPTURE: WebcamCapture = {
  mode: DEFAULT_CAPTURE_MODE,
  bitrate: DEFAULT_WEBCAM_BITRATE,
};
