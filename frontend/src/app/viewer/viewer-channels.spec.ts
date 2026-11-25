import { TestBed } from '@angular/core/testing';
import { FakeLocalStorage } from '../fake-storage.testing';
import { RoiStore } from './settings/roi-store';
import { ViewerSettingsStore } from './settings/viewer-settings.store';
import { ViewerChannels } from './viewer-channels';

/** The browser's peer connection, enough for the kit's channel to connect without a network. */
class FakePeer {
  static all: FakePeer[] = [];
  readonly receiver: { jitterBufferTarget: number | null } = { jitterBufferTarget: null };
  connectionState = 'new';
  closed = false;
  onconnectionstatechange: (() => void) | null = null;
  ontrack: (() => void) | null = null;

  constructor() {
    FakePeer.all.push(this);
  }
  addTransceiver() {
    return { receiver: this.receiver };
  }
  createDataChannel() {
    return {};
  }
  async createOffer() {
    return { type: 'offer', sdp: 'offer' };
  }
  async setLocalDescription(): Promise<void> {
    return;
  }
  async setRemoteDescription(): Promise<void> {
    return;
  }
  async getStats() {
    return new Map();
  }
  close() {
    this.closed = true;
  }
}

describe('ViewerChannels', () => {
  let channels: ViewerChannels;
  let store: ViewerSettingsStore;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    FakePeer.all = [];
    fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ type: 'answer', sdp: 'a' }) }));
    vi.stubGlobal('RTCPeerConnection', FakePeer);
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('localStorage', new FakeLocalStorage());
    TestBed.configureTestingModule({ providers: [RoiStore, ViewerSettingsStore, ViewerChannels] });
    channels = TestBed.inject(ViewerChannels);
    store = TestBed.inject(ViewerSettingsStore);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('connects each channel once, shared by its holders, and closes it after the last lets go', async () => {
    const first = channels.get(3);
    const second = channels.get(3);
    await vi.advanceTimersByTimeAsync(0);
    expect(second).toBe(first);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/channels/3/offer']);

    channels.release(3);
    expect(FakePeer.all[0].closed).toBe(false);
    channels.release(3);
    expect(FakePeer.all[0].closed).toBe(true);

    channels.get(3);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2); // a new connection, not the closed one
  });

  it("holds the video for the channel's sync buffer, and follows the setting while open", async () => {
    channels.get(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(FakePeer.all[0].receiver.jitterBufferTarget).toBe(300);

    store.set(2, 'general.videoSyncBufferMs', 800);
    TestBed.tick();
    expect(FakePeer.all[0].receiver.jitterBufferTarget).toBe(800);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('logs the connection steps to the console only while debugging is on', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    channels.get(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(log).not.toHaveBeenCalled();

    channels.setDebug(true);
    channels.release(1);
    expect(log).toHaveBeenCalledWith('[viewer][ch1]', 'closed');
  });
});
