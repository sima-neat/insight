import type { CameraMedia, PublishPeer } from './camera-media';
import type { DeviceInfo } from './webcam-publishing';

/** Every capture mode's id: what a camera that reports no limits is offered. */
export const ALL_MODE_IDS = [
  '2160p30',
  '1440p30',
  '1080p60',
  '1080p30',
  '720p60',
  '720p30',
  '480p30',
  'camera',
];

/** A camera stream whose tracks record that they were stopped. */
export class FakeCameraStream {
  readonly tracks = [
    {
      stopped: false,
      stop() {
        this.stopped = true;
      },
    },
  ];

  getTracks() {
    return this.tracks;
  }

  getVideoTracks() {
    return this.tracks;
  }

  get stopped(): boolean {
    return this.tracks.every((track) => track.stopped);
  }
}

/** A publishing peer connection: a script of the calls it saw, with its state set by the test. */
export class FakePeer {
  connectionState: RTCPeerConnectionState = 'new';
  localDescription: { sdp: string } | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  closed = false;
  /** Set to make `setRemoteDescription` wait for the test. */
  remoteGate: Promise<void> | null = null;
  /** Set to make the sender's `setParameters` wait for the test. */
  parametersGate: Promise<void> | null = null;
  /** The codecs the transceiver was pinned to; null while it was left to negotiate. */
  pinnedCodecs: { mimeType: string }[] | null = null;
  private readonly listeners: (() => void)[] = [];
  /** What `setParameters` of the sender was last given; null while it was never called. */
  appliedParameters: RTCRtpSendParameters | null = null;
  private readonly sender = {
    getParameters: () => ({ encodings: [{}] }) as RTCRtpSendParameters,
    setParameters: async (parameters: RTCRtpSendParameters) => {
      if (this.parametersGate) await this.parametersGate;
      this.appliedParameters = parameters;
    },
  };
  private readonly transceiver = {
    sender: this.sender,
    setCodecPreferences: (codecs: { mimeType: string }[]) => {
      this.pinnedCodecs = codecs;
    },
  };

  addTrack() {
    return this.sender;
  }

  getTransceivers() {
    return [this.transceiver];
  }

  addEventListener(type: string, listener: () => void): void {
    if (type === 'connectionstatechange') this.listeners.push(listener);
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'v=0\r\noffer' };
  }

  async setLocalDescription(offer: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = { sdp: offer.sdp ?? '' };
  }

  async setRemoteDescription(answer: RTCSessionDescriptionInit): Promise<void> {
    if (this.remoteGate) await this.remoteGate;
    this.remoteDescription = answer;
  }

  close(): void {
    this.closed = true;
  }

  /** What the browser does when ICE changes: the new state, then the event. */
  changeConnectionState(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    for (const listener of this.listeners) listener();
  }
}

/**
 * A `CameraMedia` that never touches a camera or the network: it lists the devices the test sets
 * and hands out `FakeCameraStream`s and `FakePeer`s, and keeps them for the test to inspect.
 */
export class FakeCameraMedia implements CameraMedia {
  canCapture = true;
  devices: DeviceInfo[] = [];
  readonly opened: { constraints: MediaStreamConstraints; stream: FakeCameraStream }[] = [];
  readonly peers: FakePeer[] = [];
  /** Codecs the browser says it can send; H.264 by default. */
  codecs: { mimeType: string }[] = [{ mimeType: 'video/VP8' }, { mimeType: 'video/H264' }];
  /** Set to make the next `enumerateDevices` fail with it. */
  enumerationFailure: unknown = null;
  /** Set to make the next `getUserMedia` fail with it. */
  openFailure: unknown = null;
  /** Set to make the next peer's `setRemoteDescription` wait for the test. */
  remoteGate: Promise<void> | null = null;
  /** Set to make the next peer's sender `setParameters` wait for the test. */
  parametersGate: Promise<void> | null = null;
  /** Set to make the next `getUserMedia` wait for the test (resolve it to hand out the stream). */
  gate: Promise<void> | null = null;
  private deviceChangeListener: (() => void) | null = null;

  async getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
    const gate = this.gate;
    this.gate = null;
    if (gate) await gate;
    if (this.openFailure) {
      const failure = this.openFailure;
      this.openFailure = null;
      throw failure;
    }
    const stream = new FakeCameraStream();
    this.opened.push({ constraints, stream });
    return stream as unknown as MediaStream;
  }

  async enumerateDevices(): Promise<readonly DeviceInfo[]> {
    if (this.enumerationFailure) {
      const failure = this.enumerationFailure;
      this.enumerationFailure = null;
      throw failure;
    }
    return this.devices;
  }

  onDeviceChange(listener: () => void): () => void {
    this.deviceChangeListener = listener;
    return () => {
      this.deviceChangeListener = null;
    };
  }

  createPeer(): PublishPeer {
    const peer = new FakePeer();
    peer.remoteGate = this.remoteGate;
    this.remoteGate = null;
    peer.parametersGate = this.parametersGate;
    this.parametersGate = null;
    this.peers.push(peer);
    return peer as unknown as PublishPeer;
  }

  videoCapabilities(): RTCRtpCapabilities {
    return { codecs: this.codecs as RTCRtpCodec[], headerExtensions: [] };
  }

  get listening(): boolean {
    return this.deviceChangeListener !== null;
  }

  /** The browser's `devicechange`, after the test changed `devices`. */
  changeDevices(devices: DeviceInfo[]): void {
    this.devices = devices;
    this.deviceChangeListener?.();
  }
}
