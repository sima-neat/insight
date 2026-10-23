import { InjectionToken } from '@angular/core';
import type { DeviceInfo } from './webcam-publishing';

/** The part of an `RTCPeerConnection` that publishing a camera drives. */
export type PublishPeer = Pick<
  RTCPeerConnection,
  | 'addEventListener'
  | 'addTrack'
  | 'close'
  | 'connectionState'
  | 'createOffer'
  | 'getTransceivers'
  | 'localDescription'
  | 'setLocalDescription'
  | 'setRemoteDescription'
>;

/**
 * The browser's media capture and WebRTC, as `CamerasService` uses them. Jsdom has none of it, and
 * a test must never touch a real camera or publish anywhere, so the service reaches the browser
 * only through this, and a test provides its own. `CAMERA_MEDIA` is the real one.
 */
export interface CameraMedia {
  /** False where the browser (or an insecure page) offers no camera capture at all. */
  readonly canCapture: boolean;
  /** Opens a camera. Rejects with the browser's `DOMException` (`NotAllowedError`, `NotFoundError`, …). */
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  enumerateDevices(): Promise<readonly DeviceInfo[]>;
  /** Calls `listener` when a device is plugged in or removed; returns what stops it. */
  onDeviceChange(listener: () => void): () => void;
  createPeer(): PublishPeer;
  /** What this browser can send as video; null when it cannot say. */
  videoCapabilities(): RTCRtpCapabilities | null;
}

/** The real thing: `navigator.mediaDevices` and the global `RTCPeerConnection`. */
export function browserCameraMedia(
  mediaDevices: MediaDevices | undefined = navigator.mediaDevices,
): CameraMedia {
  /** The service asks `canCapture` first; this is for a caller that did not. */
  const devices = (): MediaDevices => {
    if (!mediaDevices) throw new Error('This browser cannot access cameras.');
    return mediaDevices;
  };
  return {
    // Both are needed: the access request opens a camera, and the list reads what it revealed.
    canCapture:
      typeof mediaDevices?.getUserMedia === 'function' &&
      typeof mediaDevices.enumerateDevices === 'function',
    getUserMedia: async (constraints) => devices().getUserMedia(constraints),
    enumerateDevices: async () => devices().enumerateDevices(),
    onDeviceChange: (listener) => {
      const target = devices();
      target.addEventListener('devicechange', listener);
      return () => target.removeEventListener('devicechange', listener);
    },
    createPeer: () => new RTCPeerConnection(),
    videoCapabilities: () => RTCRtpSender.getCapabilities('video'),
  };
}

export const CAMERA_MEDIA = new InjectionToken<CameraMedia>('CAMERA_MEDIA', {
  providedIn: 'root',
  factory: () => browserCameraMedia(),
});
