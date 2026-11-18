import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NeatToasts } from '@sima/neat-ui/toast';
import type { Slot } from '../api.generated';
import { CAMERA_MEDIA } from './camera-media';
import { CamerasService } from './cameras.service';
import { FakeCameraMedia, FakeCameraStream, FakePeer } from './cameras.testing';
import { SlotsService } from './slots.service';
import { fileSlot, webcamSlot } from './slots.testing';
import { ApiRequestError } from './stream-lines';

const DESK = { kind: 'videoinput', deviceId: 'cam-desk', label: 'Desk camera' };
const LAPTOP = { kind: 'videoinput', deviceId: 'cam-laptop', label: 'Laptop camera' };

/** Where `webcamSlot` says a browser publishes slot `n`. */
const whipUrl = (n: number) => `https://10.0.0.2:8889/cam${n}/whip`;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('CamerasService', () => {
  let media: FakeCameraMedia;
  /** What the server holds: the slots `CamerasService` reads the publish URL and the state from. */
  const slotList = signal<readonly Slot[] | null>(null);
  /** The slot `n` as the server holds it now. */
  const slotOf = (n: number) => slotList()!.find((slot) => slot.n === n)!;
  /** Changes slot `n` on the fake server. */
  const setSlot = (n: number, change: Partial<Slot>) =>
    slotList.update((all) => all!.map((slot) => (slot.n === n ? { ...slot, ...change } : slot)));
  const slotsFake = {
    slots: slotList.asReadonly(),
    assignWebcam: vi.fn(),
    assignFile: vi.fn(),
    assignPull: vi.fn(),
    clear: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    refresh: vi.fn(),
    settleChange: vi.fn(),
  };
  const toasts = { error: vi.fn() };
  /** Every `fetch` the service made on its own (WHIP and MediaMTX's session, the exit stop). */
  let fetched: { url: string; init: RequestInit }[];
  /** How the WHIP endpoint answers; `'unreachable'` makes the request itself fail. */
  let whip: { status: number } | 'unreachable';
  /** The next WHIP offers wait for these, one each, in the order they are sent. */
  let whipGates: Promise<void>[];

  beforeEach(() => {
    vi.useFakeTimers();
    media = new FakeCameraMedia();
    media.devices = [DESK, LAPTOP];
    slotList.set(Array.from({ length: 4 }, (_, i) => webcamSlot(i + 1)));
    slotsFake.assignWebcam.mockReset().mockImplementation(async (n: number) => slotOf(n));
    slotsFake.assignFile
      .mockReset()
      .mockImplementation(async (n: number, file: string) => fileSlot(n, file));
    slotsFake.assignPull.mockReset().mockImplementation(async (n: number) => slotOf(n));
    slotsFake.clear.mockReset().mockImplementation(async (n: number) => slotOf(n));
    slotsFake.start.mockReset().mockImplementation(async (n: number) => slotOf(n));
    slotsFake.stop.mockReset().mockImplementation(async (n: number) => slotOf(n));
    // MediaMTX has the stream by the first fetch after the offer, unless a test says otherwise.
    slotsFake.refresh.mockReset().mockImplementation(async () => {
      for (const slot of slotList()!)
        if (slot.kind === 'webcam') setSlot(slot.n, { state: 'live' });
    });
    slotsFake.settleChange.mockReset().mockResolvedValue(undefined);
    toasts.error.mockReset();

    fetched = [];
    whip = { status: 201 };
    whipGates = [];
    let offersSent = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        fetched.push({ url, init });
        const isWhipOffer = init.method === 'POST' && url.endsWith('/whip');
        if (!isWhipOffer) return new Response(null, { status: 200 });
        const offer = ++offersSent;
        const gate = whipGates.shift();
        if (gate) await gate;
        if (whip === 'unreachable') throw new TypeError('Failed to fetch');
        return new Response('v=0\r\nanswer', {
          status: whip.status,
          headers: { Location: `${new URL(url).pathname}/resource-${offer}` },
        });
      }),
    );

    TestBed.configureTestingModule({
      providers: [
        { provide: CAMERA_MEDIA, useValue: media },
        { provide: SlotsService, useValue: slotsFake },
        { provide: NeatToasts, useValue: toasts },
      ],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Creates the service and lets its first camera listing land. */
  async function create(): Promise<CamerasService> {
    const service = TestBed.inject(CamerasService);
    await vi.advanceTimersByTimeAsync(0);
    return service;
  }

  /** Picks `DESK` for the slot and starts publishing it; resolves once the slot is live. */
  async function publishDesk(service: CamerasService, slot = 1): Promise<void> {
    await service.assign(slot, DESK.deviceId);
    await service.publish(slot);
  }

  /** The server keeps the webcam slot from going live for this many fetches. */
  function notLiveFor(fetches: number): void {
    for (let i = 0; i < fetches; i++)
      slotsFake.refresh.mockImplementationOnce(async () => undefined);
  }

  const posts = (suffix: string) =>
    fetched.filter((call) => call.init.method === 'POST' && call.url.endsWith(suffix));
  const deletes = () => fetched.filter((call) => call.init.method === 'DELETE');
  const peerOf = (index = 0): FakePeer => media.peers[index];
  const streamOf = (index = 0): FakeCameraStream => media.opened[index].stream;

  describe('camera access', () => {
    it('lists the cameras the browser already shows, numbering unnamed ones, without asking for access', async () => {
      media.devices = [
        { kind: 'videoinput', deviceId: 'a', label: '' },
        { kind: 'audioinput', deviceId: 'mic', label: 'Microphone' },
      ];
      const service = await create();

      expect(service.cameras()).toEqual([{ deviceId: 'a', label: 'Camera 1' }]);
      expect(service.state()).toBe('unknown');
      expect(media.opened).toEqual([]);
    });

    it('requestAccess opens a camera, releases it again, then lists the cameras that revealed', async () => {
      media.devices = [{ kind: 'videoinput', deviceId: '', label: '' }];
      const service = await create();
      expect(service.cameras()).toEqual([]);

      const gate = deferred();
      media.gate = gate.promise;
      const asking = service.requestAccess();
      await vi.advanceTimersByTimeAsync(0);
      expect(service.state()).toBe('requesting');

      media.devices = [DESK, LAPTOP]; // with permission, ids and labels appear
      gate.resolve();
      await asking;

      expect(media.opened).toHaveLength(1);
      expect(streamOf().stopped).toBe(true); // the probe must not keep the camera on
      expect(service.state()).toBe('granted');
      expect(service.error()).toBe(null);
      expect(service.cameras()).toEqual([
        { deviceId: 'cam-desk', label: 'Desk camera' },
        { deviceId: 'cam-laptop', label: 'Laptop camera' },
      ]);
    });

    it('a refusal is denied with the copy to act on, and a later success clears it', async () => {
      const service = await create();
      media.openFailure = new DOMException('no', 'NotAllowedError');

      await service.requestAccess();
      expect(service.state()).toBe('denied');
      expect(service.error()).toBe(
        'Camera permission was denied. Allow camera access for this site and try again.',
      );

      await service.requestAccess();
      expect(service.state()).toBe('granted');
      expect(service.error()).toBe(null);
    });

    it('another failure keeps what was known: no camera leaves access unknown, a busy one stays granted', async () => {
      const service = await create();
      media.openFailure = new DOMException('none', 'NotFoundError');
      await service.requestAccess();
      expect(service.state()).toBe('unknown');
      expect(service.error()).toMatch(/no longer available/);

      await service.requestAccess();
      expect(service.state()).toBe('granted');

      media.openFailure = new DOMException('busy', 'NotReadableError');
      await service.requestAccess();
      expect(service.state()).toBe('granted');
      expect(service.error()).toMatch(/in use by another application/);
    });

    it('says so when the cameras cannot be listed after access was granted', async () => {
      const service = await create();
      media.enumerationFailure = new Error('Enumeration blocked.');

      await service.requestAccess();

      expect(service.state()).toBe('granted');
      expect(service.error()).toBe('Enumeration blocked.');
    });

    it('a second request while one is open does not open another camera', async () => {
      const service = await create();
      const gate = deferred();
      media.gate = gate.promise;

      const first = service.requestAccess();
      const second = service.requestAccess();
      gate.resolve();
      await Promise.all([first, second]);

      expect(media.opened).toHaveLength(1);
    });

    it('a browser without capture is unsupported, says so on request and asks for nothing', async () => {
      media.canCapture = false;
      const service = await create();

      expect(service.state()).toBe('unsupported');
      await service.requestAccess();

      expect(service.error()).toBe('This browser cannot access cameras.');
      expect(service.state()).toBe('unsupported');
      expect(media.opened).toEqual([]);
      expect(media.listening).toBe(false);
    });

    it('follows devices being plugged in and removed', async () => {
      const service = await create();
      expect(service.cameras().map((c) => c.label)).toEqual(['Desk camera', 'Laptop camera']);

      media.changeDevices([LAPTOP]);
      await vi.advanceTimersByTimeAsync(0);
      expect(service.cameras().map((c) => c.label)).toEqual(['Laptop camera']);

      media.changeDevices([LAPTOP, DESK]);
      await vi.advanceTimersByTimeAsync(0);
      expect(service.cameras().map((c) => c.label)).toEqual(['Laptop camera', 'Desk camera']);
    });
  });

  describe('assigning a camera', () => {
    it('makes the slot a webcam on the server, then remembers the camera', async () => {
      const service = await create();

      await service.assign(2, 'cam-laptop');

      expect(slotsFake.assignWebcam).toHaveBeenCalledWith(2);
      expect(service.assignments().get(2)).toEqual({
        deviceId: 'cam-laptop',
        label: 'Laptop camera',
      });
    });

    it('with no camera makes the slot a webcam and leaves it with none', async () => {
      const service = await create();
      await service.assign(2, 'cam-laptop');

      await service.assign(2, null);
      expect(slotsFake.assignWebcam).toHaveBeenLastCalledWith(2);
      expect(service.assignments().has(2)).toBe(false);

      // A publishing slot is ended first, as for another camera.
      await publishDesk(service);
      await service.assign(1, null);
      expect(peerOf().closed).toBe(true);
      expect(slotsFake.assignWebcam).toHaveBeenLastCalledWith(1);
      expect(service.assignments().has(1)).toBe(false);
      expect(service.localStreams().has(1)).toBe(false);
    });

    it('holds the slot as changing while the request is in flight, and lets go on success and failure', async () => {
      const service = await create();
      const answer = deferred<Slot>();
      slotsFake.assignWebcam.mockReturnValueOnce(answer.promise);

      const assigning = service.assign(2, 'cam-laptop');
      expect(service.changingSlots().has(2)).toBe(true);
      expect(service.anyChanging()).toBe(true);
      answer.resolve(webcamSlot(2));
      await assigning;
      expect(service.changingSlots().size).toBe(0);
      expect(service.anyChanging()).toBe(false);

      slotsFake.assignWebcam.mockRejectedValueOnce(
        new ApiRequestError(409, 'src2 is in use.', null),
      );
      await expect(service.assign(2, 'cam-desk')).rejects.toThrow('src2 is in use.');
      expect(service.changingSlots().size).toBe(0);
    });

    it('a refused assignment shows no camera for the slot, whatever it showed before', async () => {
      const service = await create();
      await service.assign(2, 'cam-laptop');

      slotsFake.assignWebcam.mockRejectedValueOnce(
        new ApiRequestError(503, 'MediaMTX does not answer.', null),
      );
      await expect(service.assign(2, 'cam-desk')).rejects.toThrow('MediaMTX does not answer.');

      expect(service.assignments().has(2)).toBe(false);
    });

    it('a refused assignment does not clear the camera a newer assignment has set', async () => {
      const service = await create();
      const refused = deferred<never>();
      slotsFake.assignWebcam.mockReturnValueOnce(refused.promise);

      const first = service.assign(2, 'cam-desk');
      const firstOutcome = expect(first).rejects.toThrow('src2 is in use.');
      await service.assign(2, 'cam-laptop');
      refused.reject(new ApiRequestError(409, 'src2 is in use.', null));
      await firstOutcome;

      expect(service.assignments().get(2)?.deviceId).toBe('cam-laptop');
    });

    it('switching cameras on a publishing slot ends the session first', async () => {
      const service = await create();
      await publishDesk(service);

      await service.assign(1, 'cam-laptop');

      expect(peerOf().closed).toBe(true);
      expect(streamOf().stopped).toBe(true);
      expect(slotsFake.assignWebcam).toHaveBeenLastCalledWith(1);
      expect(service.localStreams().has(1)).toBe(false);
      expect(service.assignments().get(1)?.deviceId).toBe('cam-laptop');
    });

    it('a stop that lands while the assignment is in flight discards the assignment it would have made', async () => {
      const service = await create();
      const answer = deferred<Slot>();
      slotsFake.assignWebcam.mockReturnValueOnce(answer.promise);

      const assigning = service.assign(3, 'cam-desk');
      await service.release(3);
      answer.resolve(webcamSlot(3));
      await assigning;

      expect(service.assignments().has(3)).toBe(false);
    });
  });

  describe('publishing', () => {
    it("starts the slot, opens the chosen camera, pins H.264, posts the offer to the slot's WHIP URL and waits for it to be live", async () => {
      const service = await create();
      await service.assign(1, 'cam-desk');

      await service.publish(1);

      expect(slotsFake.start).toHaveBeenCalledWith(1);
      expect(media.opened[0].constraints).toEqual({ video: { deviceId: { exact: 'cam-desk' } } });
      expect(peerOf().pinnedCodecs?.map((codec) => codec.mimeType)).toEqual(['video/H264']);
      const offers = posts('/whip');
      expect(offers.map((call) => call.url)).toEqual([whipUrl(1)]);
      expect(offers[0].init.body).toBe('v=0\r\noffer');
      expect(peerOf().remoteDescription).toEqual({ type: 'answer', sdp: 'v=0\r\nanswer' });
      expect(slotsFake.refresh).toHaveBeenCalledTimes(1);
      expect(service.localStreams().get(1)).toBe(media.opened[0].stream);
      expect(service.changingSlots().size).toBe(0);
      expect(peerOf().closed).toBe(false);
    });

    it('asks for a camera first, and for a publish URL', async () => {
      const service = await create();
      await expect(service.publish(1)).rejects.toThrow(
        'Select a webcam for this source before starting it.',
      );

      await service.assign(1, 'cam-desk');
      setSlot(1, { urls: { rtsp: 'rtsp://10.0.0.2:8554/src1' } });
      await expect(service.publish(1)).rejects.toThrow(
        'No publish URL for this source; reassign the webcam and try again.',
      );
      expect(media.opened).toEqual([]);
      expect(service.changingSlots().size).toBe(0);
    });

    it('a start the server refuses opens no camera, and reports its message', async () => {
      const service = await create();
      await service.assign(1, 'cam-desk');
      slotsFake.start.mockRejectedValueOnce(
        new ApiRequestError(409, 'src1 is in use by an external publisher (rtsp).', null),
      );

      await expect(service.publish(1)).rejects.toThrow(
        'src1 is in use by an external publisher (rtsp).',
      );
      expect(media.opened).toEqual([]);
      expect(service.changingSlots().size).toBe(0);
    });

    it('holds the slot as changing from the first step to the last', async () => {
      const service = await create();
      await service.assign(1, 'cam-desk');
      const gate = deferred();
      media.gate = gate.promise;

      const publishing = service.publish(1);
      expect(service.changingSlots().has(1)).toBe(true);
      gate.resolve();
      await publishing;

      expect(service.changingSlots().has(1)).toBe(false);
    });

    it('fetches the slots every 250 ms until MediaMTX has the stream', async () => {
      const service = await create();
      await service.assign(1, 'cam-desk');
      notLiveFor(2);

      const publishing = service.publish(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(slotsFake.refresh).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(250);
      expect(slotsFake.refresh).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(250);
      await publishing;

      expect(slotsFake.refresh).toHaveBeenCalledTimes(3);
      expect(peerOf().closed).toBe(false);
    });

    it('a fetch of the slots that fails is tried again, as a slot not live yet is', async () => {
      const service = await create();
      await service.assign(1, 'cam-desk');
      slotsFake.refresh.mockRejectedValueOnce(
        new ApiRequestError(0, 'Could not reach the server.', null),
      );

      const publishing = service.publish(1);
      await vi.advanceTimersByTimeAsync(250);
      await publishing;

      expect(slotsFake.refresh).toHaveBeenCalledTimes(2);
    });

    it('gives up after 20 s, and releases the camera and the path', async () => {
      const service = await create();
      await service.assign(1, 'cam-desk');
      slotsFake.refresh.mockImplementation(async () => undefined);

      const publishing = service.publish(1);
      const outcome = expect(publishing).rejects.toThrow(
        'The webcam did not start publishing in time.',
      );
      await vi.advanceTimersByTimeAsync(20_000);
      await outcome;

      expect(peerOf().closed).toBe(true);
      expect(streamOf().stopped).toBe(true);
      expect(deletes().map((call) => call.url)).toEqual([`${whipUrl(1)}/resource-1`]);
      expect(service.localStreams().has(1)).toBe(false);
      expect(slotsFake.settleChange).toHaveBeenCalled();
    });

    it('a slot that stops being a webcam meanwhile (another tab assigned it) ends the wait at once', async () => {
      const service = await create();
      await service.assign(1, 'cam-desk');
      slotsFake.refresh.mockImplementationOnce(async () => setSlot(1, fileSlot(1, 'a.mp4')));

      await expect(service.publish(1)).rejects.toThrow('src1 is no longer a webcam source.');

      expect(slotsFake.refresh).toHaveBeenCalledTimes(1);
      expect(peerOf().closed).toBe(true);
      expect(streamOf().stopped).toBe(true);
    });

    it('a start answered for a slot that is no webcam any more opens no camera', async () => {
      const service = await create();
      await service.assign(1, 'cam-desk');
      slotsFake.start.mockResolvedValueOnce(fileSlot(1, 'a.mp4'));

      await expect(service.publish(1)).rejects.toThrow('src1 is no longer a webcam source.');
      expect(media.opened).toEqual([]);
    });

    it('describes a refused camera in terms the user can act on, and opens no connection', async () => {
      const service = await create();
      await service.assign(1, 'cam-desk');
      media.openFailure = new DOMException('no', 'NotAllowedError');

      await expect(service.publish(1)).rejects.toThrow(/Camera permission was denied/);

      expect(media.peers).toEqual([]);
      expect(service.changingSlots().size).toBe(0);
    });

    it('a browser that cannot send H.264 fails before posting anything, and releases the camera', async () => {
      const service = await create();
      await service.assign(1, 'cam-desk');
      media.codecs = [{ mimeType: 'video/VP8' }];

      await expect(service.publish(1)).rejects.toThrow(/cannot publish H\.264/);

      expect(posts('/whip')).toEqual([]);
      expect(streamOf().stopped).toBe(true);
      expect(peerOf().closed).toBe(true);
    });

    it('an unreachable WHIP endpoint reports setup guidance and releases the camera and the connection', async () => {
      const service = await create();
      await service.assign(1, 'cam-desk');
      whip = 'unreachable';

      await expect(service.publish(1)).rejects.toThrow(/certificate is trusted/);

      expect(streamOf().stopped).toBe(true);
      expect(peerOf().closed).toBe(true);
      expect(deletes()).toEqual([]); // MediaMTX never saw the session
      expect(service.localStreams().has(1)).toBe(false);
    });

    it('a rejected offer reports the status', async () => {
      const service = await create();
      await service.assign(1, 'cam-desk');
      whip = { status: 400 };

      await expect(service.publish(1)).rejects.toThrow('Webcam publish was rejected (HTTP 400).');
    });

    it('a start abandoned while the camera opens publishes nothing and says nothing', async () => {
      const service = await create();
      await service.assign(1, 'cam-desk');
      const gate = deferred();
      media.gate = gate.promise;

      const publishing = service.publish(1);
      await vi.advanceTimersByTimeAsync(0);
      await service.release(1); // the user stopped the slot while the permission prompt was open
      gate.resolve();
      await expect(publishing).resolves.toBeUndefined();

      expect(streamOf().stopped).toBe(true); // the camera that opened late is let go
      expect(media.peers).toEqual([]);
      expect(posts('/whip')).toEqual([]);
      expect(service.changingSlots().size).toBe(0);
    });

    it('a start abandoned while the offer is in flight releases the path MediaMTX opened for it', async () => {
      const service = await create();
      await service.assign(1, 'cam-desk');
      const gate = deferred();
      whipGates = [gate.promise];

      const publishing = service.publish(1);
      await vi.advanceTimersByTimeAsync(0);
      await service.release(1);
      gate.resolve();
      await expect(publishing).resolves.toBeUndefined();

      expect(peerOf().closed).toBe(true);
      expect(streamOf().stopped).toBe(true);
      expect(deletes().map((call) => call.url)).toEqual([`${whipUrl(1)}/resource-1`]);
      expect(slotsFake.refresh).not.toHaveBeenCalled();
      expect(service.localStreams().has(1)).toBe(false);
    });

    it('a start abandoned while the answer is applied never exposes its stream', async () => {
      const service = await create();
      await service.assign(1, 'cam-desk');
      const gate = deferred();
      media.remoteGate = gate.promise;

      const publishing = service.publish(1);
      await vi.advanceTimersByTimeAsync(0);
      await service.release(1);
      gate.resolve();
      await expect(publishing).resolves.toBeUndefined();

      expect(service.localStreams().has(1)).toBe(false);
      expect(slotsFake.refresh).not.toHaveBeenCalled();
      expect(peerOf().closed).toBe(true);
    });

    it('a start replaced by a new one closes its own session and leaves the new one publishing', async () => {
      const service = await create();
      await service.assign(1, 'cam-desk');
      notLiveFor(1);

      const first = service.publish(1);
      await vi.advanceTimersByTimeAsync(0);
      const second = service.publish(1);
      await vi.advanceTimersByTimeAsync(250);
      await Promise.all([first, second]);

      expect(media.peers).toHaveLength(2);
      expect(peerOf(0).closed).toBe(true);
      expect(peerOf(1).closed).toBe(false);
      expect(service.localStreams().get(1)).toBe(media.opened[1].stream);
    });

    it("a start that answers after a newer one never replaces the newer start's session", async () => {
      const service = await create();
      await service.assign(1, 'cam-desk');
      const firstOffer = deferred();
      const secondOffer = deferred();
      whipGates = [firstOffer.promise, secondOffer.promise];

      const first = service.publish(1);
      await vi.advanceTimersByTimeAsync(0);
      const second = service.publish(1); // abandons the first, which is still waiting for MediaMTX
      await vi.advanceTimersByTimeAsync(0);
      secondOffer.resolve();
      await second;
      firstOffer.resolve(); // the first offer is answered last
      await expect(first).resolves.toBeUndefined();

      expect(media.peers).toHaveLength(2);
      expect(peerOf(0).closed).toBe(true);
      expect(deletes().map((call) => call.url)).toEqual([`${whipUrl(1)}/resource-1`]);
      // The second session is still the slot's: shown, publishing, and closable.
      expect(peerOf(1).closed).toBe(false);
      expect(service.localStreams().get(1)).toBe(media.opened[1].stream);
      await service.release(1);
      expect(peerOf(1).closed).toBe(true);
      expect(media.opened[1].stream.stopped).toBe(true);
    });

    it('a start abandoned while it waits for the stream stops asking', async () => {
      const service = await create();
      await service.assign(1, 'cam-desk');
      slotsFake.refresh.mockImplementation(async () => undefined);

      const publishing = service.publish(1);
      await vi.advanceTimersByTimeAsync(300);
      expect(slotsFake.refresh).toHaveBeenCalledTimes(2);
      await service.release(1);
      await vi.advanceTimersByTimeAsync(250);
      await expect(publishing).resolves.toBeUndefined();

      expect(slotsFake.refresh).toHaveBeenCalledTimes(2);
      expect(peerOf().closed).toBe(true);
    });
  });

  describe('releasing', () => {
    it('ends the session and stops the slot, which keeps its camera', async () => {
      const service = await create();
      await publishDesk(service);

      await service.release(1);

      expect(slotsFake.stop).toHaveBeenCalledWith(1);
      expect(peerOf().closed).toBe(true);
      expect(streamOf().stopped).toBe(true);
      expect(service.localStreams().has(1)).toBe(false);
      // Stop keeps the slot assigned: the camera choice survives.
      expect(service.assignments().get(1)?.deviceId).toBe('cam-desk');
    });

    it('holds the slot as changing until the server has answered', async () => {
      const service = await create();
      await publishDesk(service);
      const answer = deferred<Slot>();
      slotsFake.stop.mockReturnValueOnce(answer.promise);

      const releasing = service.release(1);
      expect(service.changingSlots().has(1)).toBe(true);
      expect(peerOf().closed).toBe(true); // already closed: only the server's answer is awaited
      answer.resolve(webcamSlot(1, { run: false }));
      await releasing;

      expect(service.changingSlots().has(1)).toBe(false);
    });

    it('a slot this tab does not publish is stopped too, which disconnects whatever publishes it', async () => {
      const service = await create();

      await service.release(4);

      expect(slotsFake.stop).toHaveBeenCalledWith(4);
    });

    it("a refused stop rejects with the server's message and lets go of the slot", async () => {
      const service = await create();
      await publishDesk(service);
      slotsFake.stop.mockRejectedValueOnce(new ApiRequestError(404, 'There is no source 1.', null));

      await expect(service.release(1)).rejects.toThrow('There is no source 1.');

      expect(service.changingSlots().size).toBe(0);
      expect(peerOf().closed).toBe(true); // this tab's side is over whatever the server says
    });

    it('overlapping changes on one slot keep it held until the last one is done', async () => {
      const service = await create();
      const assigning = deferred<Slot>();
      const stopping = deferred<Slot>();
      slotsFake.assignWebcam.mockReturnValueOnce(assigning.promise);
      slotsFake.stop.mockReturnValueOnce(stopping.promise);

      const first = service.assign(2, 'cam-desk');
      const second = service.release(2);
      assigning.resolve(webcamSlot(2));
      await first;
      expect(service.changingSlots().has(2)).toBe(true);
      stopping.resolve(webcamSlot(2, { run: false }));
      await second;
      expect(service.changingSlots().has(2)).toBe(false);
    });

    it.each([
      ['a file', (service: CamerasService) => service.assignFile(1, 'clips/a.mp4'), 'assignFile'],
      [
        'a pull',
        (service: CamerasService) => service.assignPull(1, { url: 'rtsp://cam/stream' }),
        'assignPull',
      ],
      ['nothing', (service: CamerasService) => service.clear(1), 'clear'],
    ] as const)(
      'assigning %s to a publishing slot ends the session and forgets its camera first',
      async (_what, assign, method) => {
        const service = await create();
        await publishDesk(service);

        await assign(service);

        expect(slotsFake[method]).toHaveBeenCalledOnce();
        expect(slotsFake[method].mock.calls[0][0]).toBe(1);
        expect(peerOf().closed).toBe(true);
        expect(service.assignments().has(1)).toBe(false);
        expect(service.changingSlots().size).toBe(0);
      },
    );

    it('holds the slot while a file is assigned to it', async () => {
      const service = await create();
      const answer = deferred<Slot>();
      slotsFake.assignFile.mockReturnValueOnce(answer.promise);

      const assigning = service.assignFile(2, 'a.mp4');
      expect(service.changingSlots().has(2)).toBe(true);
      answer.resolve(fileSlot(2, 'a.mp4'));
      await assigning;

      expect(slotsFake.assignFile).toHaveBeenCalledWith(2, 'a.mp4');
      expect(service.changingSlots().has(2)).toBe(false);
    });
  });

  describe('releasing everything', () => {
    it('closes every session, keeping the camera choices for a stop', async () => {
      const service = await create();
      await publishDesk(service, 1);
      await service.assign(2, 'cam-laptop');
      await service.publish(2);
      await service.assign(3, 'cam-desk');

      service.releaseAll();

      expect(media.peers.every((peer) => peer.closed)).toBe(true);
      expect(media.opened.every((opened) => opened.stream.stopped)).toBe(true);
      expect(service.localStreams().size).toBe(0);
      // Stop all keeps the choices; the server still holds those slots as webcams.
      expect(service.assignments().size).toBe(3);
      // The bulk route stops the slots on the server; this sends nothing of its own.
      expect(slotsFake.stop).not.toHaveBeenCalled();
    });

    it('clears the camera choices when the bulk action rewrites the slots', async () => {
      const service = await create();
      await publishDesk(service, 1);
      await service.assign(2, 'cam-laptop');

      service.releaseAll({ clearAssignments: true });

      expect(service.assignments().size).toBe(0);
    });

    it('a start still in flight does not publish after the bulk action', async () => {
      const service = await create();
      await service.assign(1, 'cam-desk');
      const gate = deferred();
      media.gate = gate.promise;
      const publishing = service.publish(1);
      await vi.advanceTimersByTimeAsync(0);

      service.releaseAll();
      gate.resolve();
      await expect(publishing).resolves.toBeUndefined();

      expect(streamOf().stopped).toBe(true);
      expect(posts('/whip')).toEqual([]);
    });
  });

  describe('a lost connection', () => {
    it('failed ends the session at once and stops the slot', async () => {
      const service = await create();
      await publishDesk(service);

      peerOf().changeConnectionState('failed');
      await vi.advanceTimersByTimeAsync(0);

      expect(slotsFake.stop).toHaveBeenCalledWith(1);
      expect(streamOf().stopped).toBe(true);
      expect(service.localStreams().has(1)).toBe(false);
    });

    it('a disconnect that recovers within 10 s keeps publishing; one that does not ends the session', async () => {
      const service = await create();
      await publishDesk(service);

      peerOf().changeConnectionState('disconnected');
      await vi.advanceTimersByTimeAsync(9_000);
      peerOf().changeConnectionState('connected');
      await vi.advanceTimersByTimeAsync(20_000);
      expect(slotsFake.stop).not.toHaveBeenCalled();
      expect(peerOf().closed).toBe(false);

      peerOf().changeConnectionState('disconnected');
      await vi.advanceTimersByTimeAsync(9_999);
      expect(slotsFake.stop).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(slotsFake.stop).toHaveBeenCalledTimes(1);
      expect(peerOf().closed).toBe(true);
    });

    it('a connection closed on purpose does not stop the slot a second time', async () => {
      const service = await create();
      await publishDesk(service);

      await service.release(1);
      peerOf().changeConnectionState('closed');
      await vi.advanceTimersByTimeAsync(0);

      expect(slotsFake.stop).toHaveBeenCalledTimes(1);
    });

    it('a stop the server refuses is reported in a toast, since no action is waiting for it', async () => {
      const service = await create();
      await publishDesk(service);
      slotsFake.stop.mockRejectedValueOnce(new ApiRequestError(404, 'There is no source 1.', null));

      peerOf().changeConnectionState('failed');
      await vi.advanceTimersByTimeAsync(0);

      expect(toasts.error).toHaveBeenCalledWith('There is no source 1.');
      expect(service.changingSlots().size).toBe(0);
    });
  });

  describe('a camera that is removed', () => {
    it('a removed device tears down its slot and stops it', async () => {
      const service = await create();
      await publishDesk(service, 1);
      await service.assign(2, 'cam-laptop');
      const stopping = deferred<Slot>();
      slotsFake.stop.mockReturnValueOnce(stopping.promise);

      media.changeDevices([LAPTOP]);
      await vi.advanceTimersByTimeAsync(0);

      expect(peerOf().closed).toBe(true);
      expect(streamOf().stopped).toBe(true);
      expect(slotsFake.stop).toHaveBeenCalledWith(1);
      expect(service.changingSlots().has(1)).toBe(true); // held until the stop is answered
      stopping.resolve(webcamSlot(1, { run: false }));
      await vi.advanceTimersByTimeAsync(0);
      expect(service.changingSlots().has(1)).toBe(false);
      expect(service.assignments().has(1)).toBe(false);
      expect(service.localStreams().has(1)).toBe(false);
      // The other slot's camera is still there.
      expect(service.assignments().get(2)?.deviceId).toBe('cam-laptop');
      expect(service.cameras().map((camera) => camera.deviceId)).toEqual(['cam-laptop']);
    });

    it('a removed device abandons a start that is still opening its camera', async () => {
      const service = await create();
      await service.assign(1, 'cam-desk');
      const gate = deferred();
      media.gate = gate.promise;

      const publishing = service.publish(1);
      await vi.advanceTimersByTimeAsync(0);
      media.changeDevices([LAPTOP]);
      await vi.advanceTimersByTimeAsync(0);
      gate.resolve();
      await expect(publishing).resolves.toBeUndefined();

      expect(streamOf().stopped).toBe(true);
      expect(media.peers).toEqual([]);
      expect(posts('/whip')).toEqual([]);
      expect(service.assignments().has(1)).toBe(false);
    });

    it('a removed device abandons a start that is waiting for the stream, and stops the slot', async () => {
      const service = await create();
      await service.assign(1, 'cam-desk');
      slotsFake.refresh.mockImplementation(async () => undefined);

      const publishing = service.publish(1);
      await vi.advanceTimersByTimeAsync(300);
      media.changeDevices([LAPTOP]);
      await vi.advanceTimersByTimeAsync(250);
      await expect(publishing).resolves.toBeUndefined();

      expect(peerOf().closed).toBe(true);
      expect(slotsFake.stop).toHaveBeenCalledWith(1);
      expect(slotsFake.refresh).toHaveBeenCalledTimes(2);
    });

    it('a removed device only drops the choice for a slot this tab does not publish', async () => {
      const service = await create();
      await service.assign(2, 'cam-desk');

      media.changeDevices([LAPTOP]);
      await vi.advanceTimersByTimeAsync(0);

      expect(service.assignments().has(2)).toBe(false);
      expect(slotsFake.stop).not.toHaveBeenCalled(); // the slot may well be another browser's
    });

    it('a stop the server refuses is reported in a toast', async () => {
      const service = await create();
      await publishDesk(service, 1);
      slotsFake.stop.mockRejectedValueOnce(
        new ApiRequestError(0, 'Could not reach the server.', null),
      );

      media.changeDevices([LAPTOP]);
      await vi.advanceTimersByTimeAsync(0);

      expect(toasts.error).toHaveBeenCalledWith('Could not reach the server.');
    });
  });

  describe('leaving the page', () => {
    @Component({ template: '', changeDetection: ChangeDetectionStrategy.OnPush })
    class StreamingPageStub {
      readonly cameras = inject(CamerasService);
    }

    const pagehide = (persisted: boolean) =>
      window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted }));

    it('a publish survives navigating away from Streaming and is stopped on pagehide', async () => {
      const page = TestBed.createComponent(StreamingPageStub);
      const service = page.componentInstance.cameras;
      await vi.advanceTimersByTimeAsync(0);
      await publishDesk(service);

      page.destroy(); // the router left the Streaming page

      expect(peerOf().closed).toBe(false);
      expect(streamOf().stopped).toBe(false);
      expect(service.localStreams().get(1)).toBe(media.opened[0].stream);
      expect(deletes()).toEqual([]);
      expect(slotsFake.stop).not.toHaveBeenCalled();

      pagehide(false);

      const stops = posts('/api/slots/1/stop');
      expect(stops).toHaveLength(1);
      expect(stops[0].init.keepalive).toBe(true);
      expect(peerOf().closed).toBe(true);
      expect(streamOf().stopped).toBe(true);
      expect(deletes().map((call) => call.url)).toEqual([`${whipUrl(1)}/resource-1`]);
      expect(service.localStreams().size).toBe(0);
    });

    it('a page that may come back from the back-forward cache keeps publishing', async () => {
      const service = await create();
      await publishDesk(service);

      pagehide(true);

      expect(posts('/stop')).toEqual([]);
      expect(peerOf().closed).toBe(false);
      expect(service.localStreams().has(1)).toBe(true);
    });

    it('closes what it publishes when the app is destroyed, and stops listening for pagehide', async () => {
      const service = await create();
      await publishDesk(service);

      TestBed.resetTestingModule();
      expect(peerOf().closed).toBe(true);
      expect(media.listening).toBe(false);

      fetched.length = 0;
      pagehide(false);
      expect(fetched).toEqual([]);
      expect(service.localStreams().size).toBe(0);
    });
  });
});
