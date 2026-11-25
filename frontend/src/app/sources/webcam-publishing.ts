/**
 * WHIP publishing helpers for browser webcam sources (sima-neat/insight#120), ported from
 * `webcamPublishing.js` in sima-neat/insight#170. They are plain functions over narrow structural
 * types, so the negotiation and the teardown can be tested without a DOM, a real
 * `RTCPeerConnection` or a camera; `CamerasService` is what wires them to the browser and to the
 * slots.
 *
 * The HTTP here is `fetch`, not Angular's `HttpClient`: WHIP is a different origin from Insight's
 * API (MediaMTX's own TLS listener), so none of the app's HTTP configuration should apply to it;
 * it needs the raw SDP body and the `Location` response header; and a stop sent while the page
 * unloads needs `keepalive`, which only `fetch` has. The calls take the function as a parameter,
 * defaulting to the global one.
 */

import { captureModeIdsWithin, type CaptureLimits } from './webcam-capture';

/** The reason a connection was given up on, as the disconnect watcher reports it. */
export type ConnectionLoss = 'failed' | 'closed' | 'disconnected';

/** A camera the user can pick. */
export interface Camera {
  deviceId: string;
  label: string;
  /**
   * The ids of the capture modes within the camera's reported limits; absent while they are not
   * known (a camera that is no longer listed), when every mode is offered.
   */
  captureModeIds?: readonly string[];
}

/** The part of a `MediaDeviceInfo` the camera list reads. */
export interface DeviceInfo {
  kind: string;
  deviceId: string;
  label: string;
  /** Chrome's `InputDeviceInfo.getCapabilities()`: the camera's largest size and rate. */
  getCapabilities?(): CaptureLimits;
}

/** The part of a `fetch` response the offer reads. */
export interface WhipResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

interface WhipRequestInit {
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** `fetch`, as the offer needs it. */
export type WhipFetch = (url: string, init: WhipRequestInit) => Promise<WhipResponse>;

/** `fetch`, as the teardown and the exit stop need it: the answer is never read. */
export type FireAndForgetFetch = (url: string, init: RequestInit) => Promise<unknown>;

/** The part of a peer connection `publishWebcamOffer` drives. */
export interface OfferingPeer {
  createOffer(): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
  readonly localDescription: { readonly sdp: string } | null;
}

/**
 * What closing a session touches: the camera's tracks, the peer connection and MediaMTX's
 * resource. A start that failed part-way has some of them and not the others.
 */
export interface ClosableSession {
  stream: { getTracks(): { stop(): void }[] } | null;
  pc: { close(): void } | null;
  deleteUrl: string | null;
}

/** An error's `name` or `message`, when it has one: whatever was thrown is not necessarily an `Error`. */
function errorField(error: unknown, field: 'name' | 'message'): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const value = (error as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}

/** Whether the user (or the page's permissions policy) refused camera access. */
export function isPermissionDenied(error: unknown): boolean {
  const name = errorField(error, 'name');
  return name === 'NotAllowedError' || name === 'SecurityError';
}

/**
 * Turns a getUserMedia or publish failure into something a user can act on. Anything unrecognized
 * falls through to the underlying message rather than a generic string, because the publish
 * errors below already read well.
 */
export function describeWebcamError(error: unknown): string {
  if (isPermissionDenied(error)) {
    return 'Camera permission was denied. Allow camera access for this site and try again.';
  }
  const name = errorField(error, 'name');
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'That camera is no longer available. Refresh cameras and reselect one.';
  }
  if (name === 'NotReadableError') {
    return 'The camera could not be started (it may be in use by another application).';
  }
  return errorField(error, 'message') || 'Webcam publishing failed.';
}

/**
 * The cameras a user can pick, from enumerateDevices(). A browser can only open a camera by
 * deviceId, and Chrome on Linux reports one id for every sensor of a multi-sensor USB camera
 * (e.g. "HP 5MP Camera" and "HP IR Camera"): whichever entry is picked, the same device opens. So
 * each id is listed once, under the first name it was reported with, with the modes its limits
 * reach. Entries without an id (no permission yet) are skipped.
 */
export function camerasFromDevices(devices: readonly DeviceInfo[] | null | undefined): Camera[] {
  const cameras: Camera[] = [];
  const seen = new Set<string>();
  for (const device of devices ?? []) {
    if (device.kind !== 'videoinput' || !device.deviceId || seen.has(device.deviceId)) continue;
    seen.add(device.deviceId);
    cameras.push({
      deviceId: device.deviceId,
      label: device.label || `Camera ${cameras.length + 1}`,
      captureModeIds: captureModeIdsWithin(device.getCapabilities?.()),
    });
  }
  return cameras;
}

/**
 * MediaMTX returns the session resource in `Location`; DELETE on it releases the path immediately
 * instead of waiting for the peer connection to time out. A malformed or absent value is not
 * worth failing the publish over: closing the peer connection already ends the media flow.
 */
export function resolveDeleteUrl(
  location: string | null | undefined,
  whipUrl: string,
): string | null {
  if (!location) return null;
  try {
    return new URL(location, whipUrl).toString();
  } catch {
    return null;
  }
}

/**
 * Chrome's default offer prefers VP8. The rest of Insight (codec badges, what a Core application
 * expects on the RTSP side) assumes h264/h265/mjpeg, and sima-neat/insight#120 calls for H.264,
 * so the transceiver is pinned rather than left to negotiate.
 */
export function selectH264Codecs<C extends { mimeType: string }>(
  capabilities: { codecs?: readonly C[] } | null | undefined,
): C[] {
  return (capabilities?.codecs ?? []).filter((codec) => /^video\/H264$/i.test(codec.mimeType));
}

/** The publish failed before MediaMTX accepted it: the endpoint was unreachable, or it refused. */
export class WebcamPublishError extends Error {
  constructor(
    message: string,
    /** True when the request never got an answer (unreachable, or a certificate the browser rejected). */
    readonly transport: boolean,
    /** The HTTP status of a refusal; null for a transport failure. */
    readonly status: number | null,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'WebcamPublishError';
  }
}

/**
 * The offer is posted before ICE gathering completes, deliberately, as the Viewer's connections
 * (the kit's `neatInsightChannel`) post theirs: gathering cannot report complete until every
 * configured STUN server has answered or exhausted its RFC 5389 retransmission schedule, which
 * measured 120 ms when the server answered and 3.9-25 s when its packets were dropped. Waiting
 * would put that in front of a connection between a browser and MediaMTX on the same host or LAN,
 * which needs none of those candidates: the browser reaches MediaMTX on the host candidates in
 * the answer, and MediaMTX accepts the browser's source address as peer-reflexive.
 */
export async function publishWebcamOffer(
  peerConnection: OfferingPeer,
  whipUrl: string,
  fetchRequest: WhipFetch = globalThis.fetch,
): Promise<{ answerSdp: string; deleteUrl: string | null }> {
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);

  let response: WhipResponse;
  try {
    response = await fetchRequest(whipUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: peerConnection.localDescription?.sdp ?? '',
    });
  } catch (cause) {
    // fetch throws (a TypeError) only for transport-level failures: the endpoint unreachable, or
    // (the common one here) the browser rejecting the WHIP endpoint's certificate. That listener
    // is a separate https origin from the main UI (its own host:port), so it has to be trusted on
    // its own. The browser deliberately will not say which cause it was, so give one hint that
    // covers both: sima-neat/insight#120 asks for setup feedback the user can act on.
    throw new WebcamPublishError(
      'Could not reach the webcam publish endpoint. Check that its certificate is trusted — ' +
        'open the publish URL once in this browser to accept it — and that the endpoint is reachable.',
      true,
      null,
      cause,
    );
  }

  if (!response.ok) {
    throw new WebcamPublishError(
      `Webcam publish was rejected (HTTP ${response.status}).`,
      false,
      response.status,
    );
  }

  return {
    answerSdp: await response.text(),
    deleteUrl: resolveDeleteUrl(response.headers.get('Location'), whipUrl),
  };
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface ConfirmOptions {
  /**
   * Longer than MediaMTX's webrtcTrackGatherTimeout (10 s) plus the ICE handshake, AND the extra
   * hop before the slot reports live: the slot is the normalized output path (src{N}), which only
   * appears once the browser is publishing to the ingest path (cam{N}) AND MediaMTX's runOnReady
   * ffmpeg has spun up and produced its first frames (~1-3 s on the DevKit). A slow-starting
   * camera or normalizer is still within this window, and giving up first would tear down a
   * publish that was about to succeed.
   */
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /**
   * Not every failure is worth retrying. A slot reassigned out from under the start will never
   * become the thing we are waiting for, so retrying until the deadline would both waste the wait
   * and risk acting on the new slot.
   */
  isTerminal?: (error: unknown) => boolean;
}

/**
 * Insight reports a webcam slot as live only once MediaMTX says the path is ready, which lags
 * the WHIP exchange by the ICE handshake. Polls to a deadline rather than sleeping a fixed amount:
 * a fixed delay is either longer than a local handshake needs or too short for a slow one, and
 * this reports the real failure when the stream genuinely never arrives.
 */
export async function confirmWebcamPublishing<T>(
  attempt: () => Promise<T>,
  {
    timeoutMs = 20000,
    intervalMs = 250,
    sleep = defaultSleep,
    now = () => Date.now(),
    isTerminal = () => false,
  }: ConfirmOptions = {},
): Promise<T> {
  const deadline = now() + timeoutMs;
  let lastError: unknown;

  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      if (isTerminal(error)) throw error;
    }
    if (now() >= deadline) {
      throw lastError ?? new Error('Webcam did not start publishing in time.');
    }
    await sleep(intervalMs);
  }
}

/**
 * Releasing a webcam session means three things, and the DELETE is the only optional one: stop the
 * camera tracks so the OS releases the device, close the peer connection so MediaMTX sees the
 * publisher go away, and best-effort tell MediaMTX to drop the path now rather than waiting for
 * the WebRTC timeout. Kept here, out of the service, so the bulk paths that have to do this for
 * every session can be tested without a browser.
 */
export function closeWebcamSession(
  session: ClosableSession | null | undefined,
  fetchRequest: FireAndForgetFetch = globalThis.fetch,
): boolean {
  if (!session) return false;

  try {
    session.stream?.getTracks().forEach((track) => track.stop());
  } catch {
    // A track already ended is not worth failing the teardown over.
  }
  try {
    session.pc?.close();
  } catch {
    // Same for an already-closed peer connection.
  }

  if (session.deleteUrl) {
    try {
      fetchRequest(session.deleteUrl, { method: 'DELETE' }).catch(() => undefined);
    } catch {
      // Closing the peer connection above already ended the media flow.
    }
  }
  return true;
}

/**
 * Stop All, Reset and Auto Assign each end every webcam slot at once. The server disconnects a
 * webcam's publisher itself, but only this browser can let go of its camera and its peer
 * connection, which would otherwise keep the camera's light on and try to reconnect. Returns the
 * slots it closed and empties `sessions`.
 */
export function closeAllWebcamSessions(
  sessions: Map<number, ClosableSession> | null | undefined,
  fetchRequest: FireAndForgetFetch = globalThis.fetch,
): number[] {
  const closed: number[] = [];
  if (!sessions) return closed;
  for (const index of Array.from(sessions.keys())) {
    closeWebcamSession(sessions.get(index), fetchRequest);
    sessions.delete(index);
    closed.push(index);
  }
  return closed;
}

/**
 * When the page is unloading (reload or close), closing the peer connection only makes MediaMTX
 * drop the path ~15-20 s later, and the reloaded page can list the slots before that and show one
 * live with no camera behind it. So this stops each slot this tab publishes over a keepalive POST
 * to its stop route, which disconnects the publisher at once: a plain fetch is cancelled when the
 * page dies, keepalive lets it complete (`XMLHttpRequest`, which Angular's `HttpClient` uses here,
 * cannot do that, so this does not go through `SlotsService.stop`). Same-origin (Insight's own
 * API), so no CORS concern. Returns the slots a stop was sent for.
 */
export function recordWebcamStopsOnExit(
  slots: Iterable<number>,
  fetchRequest: FireAndForgetFetch = globalThis.fetch,
): number[] {
  const stopped: number[] = [];
  for (const n of slots) {
    try {
      fetchRequest(`/api/slots/${n}/stop`, { method: 'POST', keepalive: true }).catch(
        () => undefined,
      );
    } catch {
      // The page is unloading; there is nothing more we can do.
    }
    stopped.push(n);
  }
  return stopped;
}

export interface DisconnectWatcher {
  /** Ends the watch for good, for an intentional teardown. */
  cancel(): void;
  /** Feeds a `connectionstatechange` into the watcher. */
  update(state: RTCPeerConnectionState): void;
}

export interface DisconnectWatcherOptions<Timer> {
  onLost?: (reason: ConnectionLoss) => void;
  graceMs?: number;
  setTimer?: (callback: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
}

/**
 * `disconnected` is not the same as gone. ICE reports it for a transient interruption (a Wi-Fi
 * blip, a roam between APs) and recovers to `connected` on its own without renegotiation. Tearing
 * down on sight turns a momentary disturbance into a source the user has to set up again, so only
 * `failed` and `closed` are acted on immediately; `disconnected` gets a grace period to come back.
 *
 * `Timer` is the handle `setTimer` returns; the defaults are the global `setTimeout` pair.
 */
export function createDisconnectWatcher<Timer = ReturnType<typeof setTimeout>>({
  onLost,
  graceMs = 10000,
  setTimer = setTimeout as unknown as (callback: () => void, ms: number) => Timer,
  clearTimer = clearTimeout as unknown as (timer: Timer) => void,
}: DisconnectWatcherOptions<Timer> = {}): DisconnectWatcher {
  let timer: Timer | null = null;
  // Two different things end the wait. Recovery (`connected` after a `disconnected`) only clears
  // the pending grace timer; the watcher stays armed for the next loss. Cancellation is permanent
  // and is reserved for intentional teardown: closing the peer connection on purpose emits a
  // `closed` state change like any other, and a watcher that still reacted to it would report the
  // teardown as a lost connection and send a second stop for a session that is already gone.
  let active = true;

  function clearGrace(): void {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  function cancel(): void {
    active = false;
    clearGrace();
  }

  return {
    cancel,
    update(state) {
      if (!active) return;
      if (state === 'failed' || state === 'closed') {
        cancel();
        onLost?.(state);
        return;
      }
      if (state === 'disconnected') {
        if (timer === null) {
          timer = setTimer(() => {
            timer = null;
            onLost?.('disconnected');
          }, graceMs);
        }
        return;
      }
      // connecting / connected / new: whatever interruption there was is over, but the connection
      // can still be lost later, so stay armed.
      clearGrace();
    },
  };
}

/**
 * Insight advertises every webcam source as H.264: the codec badge, the RTSP output, and what a
 * Core application is configured to decode. If the browser cannot actually offer H.264, MediaMTX
 * will happily accept VP8 and the source then lies about its codec, failing downstream instead of
 * here. Fail here.
 */
export function pinH264<C extends { mimeType: string }>(
  transceiver: { setCodecPreferences?: (codecs: C[]) => void } | null | undefined,
  capabilities: { codecs?: readonly C[] } | null | undefined,
): C[] {
  const codecs = selectH264Codecs(capabilities);
  if (!codecs.length) {
    throw new Error(
      'This browser cannot publish H.264 video, which webcam sources require. Try Chrome, Edge or Safari.',
    );
  }
  if (!transceiver || typeof transceiver.setCodecPreferences !== 'function') {
    throw new Error(
      'This browser cannot choose a video codec, so H.264 publishing cannot be guaranteed. Try Chrome, Edge or Safari.',
    );
  }
  transceiver.setCodecPreferences(codecs);
  return codecs;
}
