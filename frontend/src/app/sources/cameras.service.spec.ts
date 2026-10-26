import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NeatToasts } from '@sima/neat-ui/toast';
import type { Slot } from './api';
import { CAMERA_MEDIA } from './camera-media';
import { CamerasService } from './cameras.service';
import { FakeCameraMedia, FakeCameraStream, FakePeer } from './cameras.testing';
import { SlotsService } from './slots.service';
import { ApiRequestError } from './stream-lines';
import { readResume, writeResume } from './webcam-resume';

const DESK = { kind: 'videoinput', deviceId: 'cam-desk', label: 'Desk camera' };
const LAPTOP = { kind: 'videoinput', deviceId: 'cam-laptop', label: 'Laptop camera' };

const whipUrl = (index: number) => `https://insight.local:8889/cam${index}/whip`;

/** A webcam slot in the shape `GET /api/mediasrc` answers. */
function webcamSlot(index: number): Slot {
  return {
    index,
    file: '',
    state: 'stopped',
    transport: '',
    codec: 'h264',
    type: 'webcam',
    allowed_transports: ['rtsp'],
    urls: { whip: whipUrl(index) },
  };
}

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
  /** What the server holds: the slots `CamerasService` reads the publish URL from. */
  const slotList = signal<readonly Slot[] | null>(null);
  const slotsFake = {
    slots: slotList.asReadonly(),
    assignWebcam: vi.fn(),
    assign: vi.fn(),
    confirmWebcamStart: vi.fn(),
    stop: vi.fn(),
    settleChange: vi.fn(),
    refresh: vi.fn(),
  };
  const toasts = { error: vi.fn() };
  /** Every `fetch` the service made on its own (WHIP and MediaMTX's session, the exit stop). */
  let fetched: { url: string; init: RequestInit }[];
  /** How the WHIP endpoint answers; `'unreachable'` makes the request itself fail. */
  let whip: { status: number; sessionId: string | null } | 'unreachable';
  /** The next WHIP offers wait for these, one each, in the order they are sent. */
  let whipGates: Promise<void>[];

  beforeEach(() => {
    vi.useFakeTimers();
    media = new FakeCameraMedia();
    media.devices = [DESK, LAPTOP];
    slotList.set(Array.from({ length: 4 }, (_, i) => webcamSlot(i + 1)));
    slotsFake.assignWebcam.mockReset().mockResolvedValue({ success: true });
    slotsFake.assign.mockReset().mockResolvedValue({ success: true });
    slotsFake.confirmWebcamStart.mockReset().mockResolvedValue({ success: true });
    slotsFake.stop.mockReset().mockResolvedValue({ success: true });
    slotsFake.settleChange.mockReset().mockResolvedValue(undefined);
    slotsFake.refresh.mockReset().mockResolvedValue(undefined);
    sessionStorage.clear();
    toasts.error.mockReset();

    fetched = [];
    whip = { status: 201, sessionId: 'session-1' };
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
        const headers: Record<string, string> = {
          Location: `${new URL(url).pathname}/resource-${offer}`,
        };
        if (whip.sessionId) headers['Id'] = whip.sessionId;
        return new Response('v=0\r\nanswer', { status: whip.status, headers });
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
    sessionStorage.clear();
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
    it('registers the slot as a webcam on the server, then remembers the camera', async () => {
      const service = await create();

      await service.assign(2, 'cam-laptop');

      expect(slotsFake.assignWebcam).toHaveBeenCalledWith({ index: 2 });
      expect(service.assignments().get(2)).toEqual({
        deviceId: 'cam-laptop',
        label: 'Laptop camera',
      });
    });

    it('with no camera registers the slot as a webcam and leaves it with none', async () => {
      const service = await create();
      await service.assign(2, 'cam-laptop');

      await service.assign(2, null);
      expect(slotsFake.assignWebcam).toHaveBeenLastCalledWith({ index: 2 });
      expect(service.assignments().has(2)).toBe(false);

      // A publishing slot is ended first, as for another camera.
      await publishDesk(service);
      await service.assign(1, null);
      expect(peerOf().closed).toBe(true);
      expect(slotsFake.assignWebcam).toHaveBeenLastCalledWith({
        index: 1,
        publisher_released: true,
        publisher_session: 'session-1',
      });
      expect(service.assignments().has(1)).toBe(false);
      expect(service.localStreams().has(1)).toBe(false);
    });

    it('holds the slot as changing while the request is in flight, and lets go on success and failure', async () => {
      const service = await create();
      const answer = deferred<{ success: true }>();
      slotsFake.assignWebcam.mockReturnValueOnce(answer.promise);

      const assigning = service.assign(2, 'cam-laptop');
      expect(service.changingSlots().has(2)).toBe(true);
      expect(service.anyChanging()).toBe(true);
      answer.resolve({ success: true });
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
        new ApiRequestError(502, 'MediaMTX is unreachable.', null),
      );
      await expect(service.assign(2, 'cam-desk')).rejects.toThrow('MediaMTX is unreachable.');

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

    it('switching cameras on a publishing slot ends the session first and names it in the release claim', async () => {
      const service = await create();
      await publishDesk(service);

      await service.assign(1, 'cam-laptop');

      expect(peerOf().closed).toBe(true);
      expect(streamOf().stopped).toBe(true);
      expect(slotsFake.assignWebcam).toHaveBeenLastCalledWith({
        index: 1,
        publisher_released: true,
        publisher_session: 'session-1',
      });
      expect(service.localStreams().has(1)).toBe(false);
      expect(service.assignments().get(1)?.deviceId).toBe('cam-laptop');
    });

    it('a stop that lands while the assignment is in flight discards the assignment it would have made', async () => {
      const service = await create();
      const answer = deferred<{ success: true }>();
      slotsFake.assignWebcam.mockReturnValueOnce(answer.promise);

      const assigning = service.assign(3, 'cam-desk');
      await service.release(3);
      answer.resolve({ success: true });
      await assigning;

      expect(service.assignments().has(3)).toBe(false);
    });
  });

  describe('publishing', () => {
    it('opens the chosen camera, pins H.264, posts the offer to the slot and confirms the start with expect_type webcam', async () => {
      const service = await create();
      await service.assign(1, 'cam-desk');

      await service.publish(1);

      expect(media.opened[0].constraints).toEqual({ video: { deviceId: { exact: 'cam-desk' } } });
      expect(peerOf().pinnedCodecs?.map((codec) => codec.mimeType)).toEqual(['video/H264']);
      const offers = posts('/whip');
      expect(offers.map((call) => call.url)).toEqual([whipUrl(1)]);
      expect(offers[0].init.body).toBe('v=0\r\noffer');
      expect(peerOf().remoteDescription).toEqual({ type: 'answer', sdp: 'v=0\r\nanswer' });
      expect(slotsFake.confirmWebcamStart).toHaveBeenCalledWith(1);
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
      slotList.set([{ ...webcamSlot(1), urls: {} }]);
      await expect(service.publish(1)).rejects.toThrow(
        'No publish URL for this source; reassign the webcam and try again.',
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

    it('keeps asking the server until MediaMTX reports the path, every 250 ms', async () => {
      const service = await create();
      await service.assign(1, 'cam-desk');
      slotsFake.confirmWebcamStart
        .mockRejectedValueOnce(new ApiRequestError(409, 'Webcam is not publishing yet', null))
        .mockRejectedValueOnce(new ApiRequestError(409, 'Webcam is not publishing yet', null));

      const publishing = service.publish(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(slotsFake.confirmWebcamStart).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(250);
      expect(slotsFake.confirmWebcamStart).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(250);
      await publishing;

      expect(slotsFake.confirmWebcamStart).toHaveBeenCalledTimes(3);
      expect(peerOf().closed).toBe(false);
    });

    it('asks every 250 ms without refetching between attempts, and fetches the slots once when the slot is live', async () => {
      const service = await create();
      await service.assign(1, 'cam-desk');
      for (let refusals = 0; refusals < 4; refusals++) {
        slotsFake.confirmWebcamStart.mockRejectedValueOnce(
          new ApiRequestError(409, 'Webcam is not publishing yet', null),
        );
      }
      // A slow refetch would delay each step if the loop waited for one.
      slotsFake.settleChange.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 1000)),
      );

      const publishing = service.publish(1);
      await vi.advanceTimersByTimeAsync(0);
      for (const attempts of [1, 2, 3, 4]) {
        expect(slotsFake.confirmWebcamStart).toHaveBeenCalledTimes(attempts);
        await vi.advanceTimersByTimeAsync(250);
      }
      expect(slotsFake.confirmWebcamStart).toHaveBeenCalledTimes(5);
      expect(slotsFake.settleChange).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      await publishing;

      expect(slotsFake.settleChange).toHaveBeenCalledTimes(1);
    });

    it('gives up after 20 s with the last server message, and releases the camera and the path', async () => {
      const service = await create();
      await service.assign(1, 'cam-desk');
      slotsFake.confirmWebcamStart.mockRejectedValue(
        new ApiRequestError(409, 'Webcam is not publishing yet', null),
      );

      const publishing = service.publish(1);
      const outcome = expect(publishing).rejects.toThrow('Webcam is not publishing yet');
      await vi.advanceTimersByTimeAsync(20_000);
      await outcome;

      expect(peerOf().closed).toBe(true);
      expect(streamOf().stopped).toBe(true);
      expect(deletes().map((call) => call.url)).toEqual([
        'https://insight.local:8889/cam1/whip/resource-1',
      ]);
      expect(service.localStreams().has(1)).toBe(false);
      expect(slotsFake.settleChange).toHaveBeenCalled();
    });

    it.each([
      [410, 'src1 is no longer a webcam.'],
      [502, 'MediaMTX is unreachable.'],
    ])('a %s from the server ends the wait at once, with its message', async (status, message) => {
      const service = await create();
      await service.assign(1, 'cam-desk');
      slotsFake.confirmWebcamStart.mockRejectedValue(new ApiRequestError(status, message, null));

      await expect(service.publish(1)).rejects.toThrow(message);

      expect(slotsFake.confirmWebcamStart).toHaveBeenCalledTimes(1);
      expect(peerOf().closed).toBe(true);
      expect(streamOf().stopped).toBe(true);
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
      whip = { status: 400, sessionId: null };

      await expect(service.publish(1)).rejects.toThrow('Webcam publish was rejected (HTTP 400).');
    });

    it('a start abandoned while the camera opens publishes nothing and says nothing', async () => {
      const service = await create();
      await service.assign(1, 'cam-desk');
      const gate = deferred();
      media.gate = gate.promise;

      const publishing = service.publish(1);
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
      expect(deletes().map((call) => call.url)).toEqual([
        'https://insight.local:8889/cam1/whip/resource-1',
      ]);
      expect(slotsFake.confirmWebcamStart).not.toHaveBeenCalled();
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
      expect(slotsFake.confirmWebcamStart).not.toHaveBeenCalled();
      expect(peerOf().closed).toBe(true);
    });

    it('a start replaced by a new one closes its own session and leaves the new one publishing', async () => {
      const service = await create();
      await service.assign(1, 'cam-desk');
      slotsFake.confirmWebcamStart.mockRejectedValueOnce(
        new ApiRequestError(409, 'Webcam is not publishing yet', null),
      );

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
      expect(deletes().map((call) => call.url)).toEqual([
        'https://insight.local:8889/cam1/whip/resource-1',
      ]);
      // The second session is still the slot's: shown, publishing, and closable.
      expect(peerOf(1).closed).toBe(false);
      expect(service.localStreams().get(1)).toBe(media.opened[1].stream);
      await service.release(1);
      expect(peerOf(1).closed).toBe(true);
      expect(media.opened[1].stream.stopped).toBe(true);
    });

    it('a start abandoned while the server confirms stops asking', async () => {
      const service = await create();
      await service.assign(1, 'cam-desk');
      slotsFake.confirmWebcamStart.mockRejectedValue(
        new ApiRequestError(409, 'Webcam is not publishing yet', null),
      );

      const publishing = service.publish(1);
      await vi.advanceTimersByTimeAsync(300);
      expect(slotsFake.confirmWebcamStart).toHaveBeenCalledTimes(2);
      await service.release(1);
      await vi.advanceTimersByTimeAsync(250);
      await expect(publishing).resolves.toBeUndefined();

      expect(slotsFake.confirmWebcamStart).toHaveBeenCalledTimes(2);
      expect(peerOf().closed).toBe(true);
    });
  });

  describe('releasing', () => {
    it('stops the slot naming the WHIP session, so a slot another browser took is left alone', async () => {
      const service = await create();
      await publishDesk(service);

      await service.release(1);

      expect(slotsFake.stop).toHaveBeenCalledWith({
        index: 1,
        publisher_released: true,
        publisher_session: 'session-1',
      });
      expect(peerOf().closed).toBe(true);
      expect(streamOf().stopped).toBe(true);
      expect(service.localStreams().has(1)).toBe(false);
      // Stop keeps the slot assigned: the camera choice survives.
      expect(service.assignments().get(1)?.deviceId).toBe('cam-desk');
    });

    it('holds the slot as changing until the server has answered', async () => {
      const service = await create();
      await publishDesk(service);
      const answer = deferred<{ success: true }>();
      slotsFake.stop.mockReturnValueOnce(answer.promise);

      const releasing = service.release(1);
      expect(service.changingSlots().has(1)).toBe(true);
      expect(peerOf().closed).toBe(true); // already closed: only the server's answer is awaited
      answer.resolve({ success: true });
      await releasing;

      expect(service.changingSlots().has(1)).toBe(false);
    });

    it('a slot this tab does not publish gets a plain stop, which the server confirms with MediaMTX', async () => {
      const service = await create();

      await service.release(4);

      expect(slotsFake.stop).toHaveBeenCalledWith({ index: 4 });
    });

    it('a refused stop rejects with the server message and lets go of the slot', async () => {
      const service = await create();
      await publishDesk(service);
      slotsFake.stop.mockRejectedValueOnce(new ApiRequestError(409, 'src1 changed hands.', null));

      await expect(service.release(1)).rejects.toThrow('src1 changed hands.');

      expect(service.changingSlots().size).toBe(0);
      expect(peerOf().closed).toBe(true); // this tab's side is over whatever the server says
    });

    it('overlapping changes on one slot keep it held until the last one is done', async () => {
      const service = await create();
      const assigning = deferred<{ success: true }>();
      const stopping = deferred<{ success: true }>();
      slotsFake.assignWebcam.mockReturnValueOnce(assigning.promise);
      slotsFake.stop.mockReturnValueOnce(stopping.promise);

      const first = service.assign(2, 'cam-desk');
      const second = service.release(2);
      assigning.resolve({ success: true });
      await first;
      expect(service.changingSlots().has(2)).toBe(true);
      stopping.resolve({ success: true });
      await second;
      expect(service.changingSlots().has(2)).toBe(false);
    });

    it('converting a publishing slot to a file ends the session and passes the release claim', async () => {
      const service = await create();
      await publishDesk(service);

      await service.assignFile({ index: 1, file: 'clips/a.mp4' });

      expect(slotsFake.assign).toHaveBeenCalledWith({
        index: 1,
        file: 'clips/a.mp4',
        publisher_released: true,
        publisher_session: 'session-1',
      });
      expect(peerOf().closed).toBe(true);
      expect(service.assignments().has(1)).toBe(false);
      expect(service.changingSlots().size).toBe(0);
    });

    it('assigning a file to a slot without a session sends no claim, and holds the slot meanwhile', async () => {
      const service = await create();
      const answer = deferred<{ success: true }>();
      slotsFake.assign.mockReturnValueOnce(answer.promise);

      const assigning = service.assignFile({ index: 2, file: '', fps: null });
      expect(service.changingSlots().has(2)).toBe(true);
      answer.resolve({ success: true });
      await assigning;

      expect(slotsFake.assign).toHaveBeenCalledWith({ index: 2, file: '', fps: null });
      expect(service.changingSlots().has(2)).toBe(false);
    });
  });

  describe('releasing everything', () => {
    it('closes every session and returns the claims the bulk request needs, only for sessions it can name', async () => {
      const service = await create();
      await publishDesk(service, 1);
      whip = { status: 201, sessionId: null };
      await service.assign(2, 'cam-laptop');
      await service.publish(2);
      whip = { status: 201, sessionId: 'session-3' };
      await service.assign(3, 'cam-desk');
      await service.publish(3);

      const claims = service.releaseAll();

      expect(claims).toEqual([
        { index: 1, session: 'session-1' },
        { index: 3, session: 'session-3' },
      ]);
      expect(media.peers.every((peer) => peer.closed)).toBe(true);
      expect(media.opened.every((opened) => opened.stream.stopped)).toBe(true);
      expect(service.localStreams().size).toBe(0);
      // Stop all keeps the choices; the server still holds those slots as webcams.
      expect(service.assignments().size).toBe(3);
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

      expect(service.releaseAll()).toEqual([]);
      gate.resolve();
      await expect(publishing).resolves.toBeUndefined();

      expect(streamOf().stopped).toBe(true);
      expect(posts('/whip')).toEqual([]);
    });

    it('returns no claims when nothing is published', async () => {
      const service = await create();
      expect(service.releaseAll()).toEqual([]);
    });
  });

  describe('a lost connection', () => {
    it('failed ends the session at once with a session-bound stop', async () => {
      const service = await create();
      await publishDesk(service);

      peerOf().changeConnectionState('failed');
      await vi.advanceTimersByTimeAsync(0);

      expect(slotsFake.stop).toHaveBeenCalledWith({
        index: 1,
        publisher_released: true,
        publisher_session: 'session-1',
      });
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
      slotsFake.stop.mockRejectedValueOnce(new ApiRequestError(409, 'src1 changed hands.', null));

      peerOf().changeConnectionState('failed');
      await vi.advanceTimersByTimeAsync(0);

      expect(toasts.error).toHaveBeenCalledWith('src1 changed hands.');
      expect(service.changingSlots().size).toBe(0);
    });
  });

  describe('a camera that is removed', () => {
    it('a removed device tears down its slot and sends a session-bound stop', async () => {
      const service = await create();
      await publishDesk(service, 1);
      await service.assign(2, 'cam-laptop');
      const stopping = deferred<{ success: true }>();
      slotsFake.stop.mockReturnValueOnce(stopping.promise);

      media.changeDevices([LAPTOP]);
      await vi.advanceTimersByTimeAsync(0);

      expect(peerOf().closed).toBe(true);
      expect(streamOf().stopped).toBe(true);
      expect(slotsFake.stop).toHaveBeenCalledWith({
        index: 1,
        publisher_released: true,
        publisher_session: 'session-1',
      });
      expect(service.changingSlots().has(1)).toBe(true); // held until the stop is answered
      stopping.resolve({ success: true });
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
      media.changeDevices([LAPTOP]);
      await vi.advanceTimersByTimeAsync(0);
      gate.resolve();
      await expect(publishing).resolves.toBeUndefined();

      expect(streamOf().stopped).toBe(true);
      expect(media.peers).toEqual([]);
      expect(posts('/whip')).toEqual([]);
      expect(service.assignments().has(1)).toBe(false);
    });

    it('a removed device abandons a start that is waiting for the server, and sends a session-bound stop', async () => {
      const service = await create();
      await service.assign(1, 'cam-desk');
      slotsFake.confirmWebcamStart.mockRejectedValue(
        new ApiRequestError(409, 'Webcam is not publishing yet', null),
      );

      const publishing = service.publish(1);
      await vi.advanceTimersByTimeAsync(300);
      media.changeDevices([LAPTOP]);
      await vi.advanceTimersByTimeAsync(250);
      await expect(publishing).resolves.toBeUndefined();

      expect(peerOf().closed).toBe(true);
      expect(slotsFake.stop).toHaveBeenCalledWith({
        index: 1,
        publisher_released: true,
        publisher_session: 'session-1',
      });
      expect(slotsFake.confirmWebcamStart).toHaveBeenCalledTimes(2);
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
        new ApiRequestError(502, 'MediaMTX is unreachable.', null),
      );

      media.changeDevices([LAPTOP]);
      await vi.advanceTimersByTimeAsync(0);

      expect(toasts.error).toHaveBeenCalledWith('MediaMTX is unreachable.');
    });
  });

  describe('remembering the tab’s webcams for a reload', () => {
    const entry = (slot: number) => readResume().get(slot);
    const pagehide = (persisted: boolean) =>
      window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted }));

    it('assigning a camera remembers it as not sending; assigning none, or a refused one, forgets it', async () => {
      const service = await create();

      await service.assign(2, 'cam-laptop');
      expect(entry(2)).toEqual({ deviceId: 'cam-laptop', sending: false });

      await service.assign(2, null);
      expect(entry(2)).toBeUndefined();

      await service.assign(2, 'cam-desk');
      slotsFake.assignWebcam.mockRejectedValueOnce(new ApiRequestError(409, 'In use.', null));
      await expect(service.assign(2, 'cam-laptop')).rejects.toThrow('In use.');
      expect(entry(2)).toBeUndefined();
    });

    it('a publish remembers the camera as sending only once the server confirmed the slot live', async () => {
      const service = await create();
      await service.assign(1, 'cam-desk');
      const answer = deferred<{ success: true }>();
      slotsFake.confirmWebcamStart.mockReturnValueOnce(answer.promise);

      const publishing = service.publish(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(entry(1)).toEqual({ deviceId: 'cam-desk', sending: false });

      answer.resolve({ success: true });
      await publishing;
      expect(entry(1)).toEqual({ deviceId: 'cam-desk', sending: true });
    });

    it('a publish that fails, or is replaced before it is confirmed, is not remembered as sending', async () => {
      const service = await create();
      await service.assign(1, 'cam-desk');
      media.openFailure = new DOMException('busy', 'NotReadableError');
      await expect(service.publish(1)).rejects.toThrow();
      expect(entry(1)).toEqual({ deviceId: 'cam-desk', sending: false });

      const gate = deferred();
      media.gate = gate.promise;
      const publishing = service.publish(1);
      await service.release(1);
      gate.resolve();
      await publishing;
      expect(entry(1)).toEqual({ deviceId: 'cam-desk', sending: false });
    });

    it('switching cameras on a live webcam remembers the new camera, sending once it is live', async () => {
      const service = await create();
      await publishDesk(service);

      await service.assign(1, 'cam-laptop');
      expect(entry(1)).toEqual({ deviceId: 'cam-laptop', sending: false });

      await service.publish(1);
      expect(entry(1)).toEqual({ deviceId: 'cam-laptop', sending: true });
    });

    it('stopping, or losing the connection, keeps the camera and remembers it as not sending', async () => {
      const service = await create();
      await publishDesk(service);
      await service.release(1);
      expect(entry(1)).toEqual({ deviceId: 'cam-desk', sending: false });

      await service.publish(1);
      expect(entry(1)?.sending).toBe(true);
      peerOf(1).changeConnectionState('failed');
      await vi.advanceTimersByTimeAsync(0);
      expect(entry(1)).toEqual({ deviceId: 'cam-desk', sending: false });
    });

    it('clearing the slot, or a camera that is gone, forgets it', async () => {
      const service = await create();
      await publishDesk(service, 1);
      await service.assign(2, 'cam-laptop');

      await service.assignFile({ index: 1, file: '' });
      expect(entry(1)).toBeUndefined();

      media.changeDevices([DESK]);
      await vi.advanceTimersByTimeAsync(0);
      expect(entry(2)).toBeUndefined();
    });

    it('a bulk stop remembers every camera as not sending; one that rewrites the slots forgets them', async () => {
      const service = await create();
      await publishDesk(service, 1);
      await service.assign(2, 'cam-laptop');
      expect(entry(1)?.sending).toBe(true);

      service.releaseAll();
      expect(entry(1)).toEqual({ deviceId: 'cam-desk', sending: false });
      expect(entry(2)).toEqual({ deviceId: 'cam-laptop', sending: false });

      service.releaseAll({ clearAssignments: true });
      expect(readResume().size).toBe(0);
    });

    it('leaving the page writes nothing, so a reload finds the camera still sending', async () => {
      const service = await create();
      await publishDesk(service);

      pagehide(false);
      expect(service.localStreams().size).toBe(0);
      expect(entry(1)).toEqual({ deviceId: 'cam-desk', sending: true });

      TestBed.resetTestingModule();
      expect(entry(1)).toEqual({ deviceId: 'cam-desk', sending: true });
    });
  });

  describe('resuming after a reload', () => {
    const remember = (slot: number, deviceId: string, sending: boolean) =>
      writeResume(slot, { deviceId, sending });
    const serverHolds = (...slots: Slot[]) =>
      slotList.update((all) => (all ?? []).map((s) => slots.find((o) => o.index === s.index) ?? s));
    const entries = () => [...readResume()];

    it('reassigns a sending camera without asking the server, and starts it again', async () => {
      remember(1, 'cam-desk', true);
      const service = await create();
      await vi.advanceTimersByTimeAsync(0);

      expect(slotsFake.refresh).toHaveBeenCalledTimes(1);
      expect(slotsFake.assignWebcam).not.toHaveBeenCalled();
      expect(service.assignments().get(1)).toEqual({ deviceId: 'cam-desk', label: 'Desk camera' });
      expect(media.opened[0].constraints).toEqual({ video: { deviceId: { exact: 'cam-desk' } } });
      expect(posts('/whip')).toHaveLength(1);
      expect(slotsFake.confirmWebcamStart).toHaveBeenCalledWith(1);
      expect(service.localStreams().has(1)).toBe(true);
      expect(entries()).toEqual([[1, { deviceId: 'cam-desk', sending: true }]]);
      expect(toasts.error).not.toHaveBeenCalled();
    });

    it('resumes each slot on its own camera', async () => {
      remember(1, 'cam-desk', true);
      remember(3, 'cam-laptop', true);
      const service = await create();
      await vi.advanceTimersByTimeAsync(0);

      expect(service.assignments().get(1)?.deviceId).toBe('cam-desk');
      expect(service.assignments().get(3)?.deviceId).toBe('cam-laptop');
      expect(posts('/whip').map((call) => call.url)).toEqual([whipUrl(1), whipUrl(3)]);
    });

    it('reassigns a camera that was not sending and never starts it', async () => {
      remember(1, 'cam-desk', false);
      const service = await create();
      await vi.advanceTimersByTimeAsync(0);

      expect(service.assignments().get(1)?.deviceId).toBe('cam-desk');
      expect(media.opened).toEqual([]);
      expect(posts('/whip')).toEqual([]);
      expect(slotsFake.confirmWebcamStart).not.toHaveBeenCalled();
      expect(entries()).toEqual([[1, { deviceId: 'cam-desk', sending: false }]]);
    });

    it('reads nothing from the server when there is nothing to resume', async () => {
      await create();
      await vi.advanceTimersByTimeAsync(0);
      expect(slotsFake.refresh).not.toHaveBeenCalled();
    });

    it('resumes once, not on every device change', async () => {
      remember(1, 'cam-desk', false);
      await create();
      await vi.advanceTimersByTimeAsync(0);
      remember(2, 'cam-laptop', true);

      media.changeDevices([DESK, LAPTOP]);
      await vi.advanceTimersByTimeAsync(0);

      expect(slotsFake.refresh).toHaveBeenCalledTimes(1);
      expect(media.opened).toEqual([]);
    });

    it('drops an entry whose camera is no longer there, and starts nothing', async () => {
      remember(1, 'cam-unplugged', true);
      const service = await create();
      await vi.advanceTimersByTimeAsync(0);

      expect(entries()).toEqual([]);
      expect(service.assignments().size).toBe(0);
      expect(media.opened).toEqual([]);
      expect(toasts.error).not.toHaveBeenCalled();
    });

    it('drops the entries when the camera permission is not granted (the browser lists no ids)', async () => {
      media.devices = [{ kind: 'videoinput', deviceId: '', label: '' }];
      remember(1, 'cam-desk', true);
      const service = await create();
      await vi.advanceTimersByTimeAsync(0);

      expect(service.cameras()).toEqual([]);
      expect(entries()).toEqual([]);
      expect(service.assignments().size).toBe(0);
      expect(media.opened).toEqual([]);
      expect(toasts.error).not.toHaveBeenCalled();
    });

    const taken: [string, Slot][] = [
      ['live', { ...webcamSlot(1), state: 'playing' }],
      [
        'held by an external publisher',
        {
          ...webcamSlot(1),
          state: 'external',
          external: { source: 'ffmpeg', reader_count: 0 } as unknown as Slot['external'],
        },
      ],
      ['pulled', { ...webcamSlot(1), state: 'pulled' }],
      ['no longer a webcam', { ...webcamSlot(1), type: 'file', file: 'a.mp4' }],
    ];
    it.each(taken)(
      'leaves a slot that is %s to whoever has it: drops the entry, starts nothing',
      async (_why, slot) => {
        serverHolds(slot);
        remember(1, 'cam-desk', true);
        const service = await create();
        await vi.advanceTimersByTimeAsync(0);

        expect(entries()).toEqual([]);
        expect(service.assignments().size).toBe(0);
        expect(media.opened).toEqual([]);
        expect(posts('/whip')).toEqual([]);
        expect(slotsFake.assignWebcam).not.toHaveBeenCalled();
        expect(toasts.error).not.toHaveBeenCalled();
      },
    );

    it('drops an entry for a slot the server does not list', async () => {
      slotList.set([]);
      remember(1, 'cam-desk', true);
      await create();
      await vi.advanceTimersByTimeAsync(0);

      expect(entries()).toEqual([]);
      expect(media.opened).toEqual([]);
    });

    it('skips a slot that is taken while leaving the others to resume', async () => {
      serverHolds({ ...webcamSlot(1), state: 'playing' });
      remember(1, 'cam-desk', true);
      remember(2, 'cam-laptop', true);
      const service = await create();
      await vi.advanceTimersByTimeAsync(0);

      expect(entries()).toEqual([[2, { deviceId: 'cam-laptop', sending: true }]]);
      expect(service.assignments().has(1)).toBe(false);
      expect(posts('/whip').map((call) => call.url)).toEqual([whipUrl(2)]);
    });

    it('starts nothing when the slots cannot be read, and drops the entries without a toast', async () => {
      slotsFake.refresh.mockRejectedValue(new ApiRequestError(0, 'Unreachable.', null));
      remember(1, 'cam-desk', true);
      const service = await create();
      await vi.advanceTimersByTimeAsync(0);

      expect(entries()).toEqual([]);
      expect(service.assignments().size).toBe(0);
      expect(media.opened).toEqual([]);
      expect(toasts.error).not.toHaveBeenCalled();
    });

    it('leaves a slot alone that the user picked a camera for while the slots were being read', async () => {
      const read = deferred();
      slotsFake.refresh.mockReturnValue(read.promise);
      remember(1, 'cam-desk', true);
      const service = await create();
      await service.assign(1, 'cam-laptop');

      read.resolve();
      await vi.advanceTimersByTimeAsync(0);

      expect(service.assignments().get(1)?.deviceId).toBe('cam-laptop');
      expect(entries()).toEqual([[1, { deviceId: 'cam-laptop', sending: false }]]);
      expect(media.opened).toEqual([]);
    });

    describe('when the user stops, resets or rewrites the slot while the slots are being read', () => {
      /** Resumes camera 'cam-desk' on slot 1 with the slot read held open, then lets `act` happen. */
      async function actDuringRead(
        act: (service: CamerasService) => unknown,
      ): Promise<CamerasService> {
        const read = deferred();
        slotsFake.refresh.mockReturnValue(read.promise);
        remember(1, 'cam-desk', true);
        const service = await create();
        await act(service);
        read.resolve();
        await vi.advanceTimersByTimeAsync(0);
        return service;
      }

      it('Stop all is honoured: the camera never starts and is remembered as not sending', async () => {
        const service = await actDuringRead((s) => s.releaseAll());

        expect(media.opened).toEqual([]);
        expect(posts('/whip')).toEqual([]);
        expect(service.localStreams().size).toBe(0);
        expect(entries()).toEqual([[1, { deviceId: 'cam-desk', sending: false }]]);
      });

      it('Reset or Auto assign is honoured: nothing is assigned or started, and nothing is remembered', async () => {
        const service = await actDuringRead((s) => s.releaseAll({ clearAssignments: true }));

        expect(media.opened).toEqual([]);
        expect(service.assignments().size).toBe(0);
        expect(entries()).toEqual([]);
        expect(toasts.error).not.toHaveBeenCalled();
      });

      it('a file assigned to the slot is honoured: no camera opens and no error shows', async () => {
        const service = await actDuringRead((s) => s.assignFile({ index: 1, file: 'a.mp4' }));

        expect(media.opened).toEqual([]);
        expect(service.assignments().size).toBe(0);
        expect(entries()).toEqual([]);
        expect(slotsFake.confirmWebcamStart).not.toHaveBeenCalled();
        expect(toasts.error).not.toHaveBeenCalled();
      });
    });

    it('keeps the entry as not sending and tells the user once when the camera will not start', async () => {
      media.openFailure = new DOMException('busy', 'NotReadableError');
      remember(1, 'cam-desk', true);
      const service = await create();
      await vi.advanceTimersByTimeAsync(0);

      expect(toasts.error).toHaveBeenCalledTimes(1);
      expect(toasts.error).toHaveBeenCalledWith(expect.stringMatching(/in use by another/));
      expect(entries()).toEqual([[1, { deviceId: 'cam-desk', sending: false }]]);
      expect(service.assignments().get(1)?.deviceId).toBe('cam-desk');
      expect(service.localStreams().size).toBe(0);
      expect(posts('/whip')).toEqual([]);
    });

    it('says the same failure once even when several slots meet it', async () => {
      whip = { status: 500, sessionId: null };
      remember(1, 'cam-desk', true);
      remember(2, 'cam-laptop', true);
      await create();
      await vi.advanceTimersByTimeAsync(0);

      expect(entries()).toEqual([
        [1, { deviceId: 'cam-desk', sending: false }],
        [2, { deviceId: 'cam-laptop', sending: false }],
      ]);
      expect(toasts.error).toHaveBeenCalledTimes(1);
    });

    it('does nothing, and says nothing, where session storage is unusable', async () => {
      vi.stubGlobal('sessionStorage', {
        getItem: () => {
          throw new DOMException('The operation is insecure.', 'SecurityError');
        },
        setItem: () => {
          throw new DOMException('The operation is insecure.', 'SecurityError');
        },
        removeItem: () => {
          throw new DOMException('The operation is insecure.', 'SecurityError');
        },
      });
      const service = await create();
      await vi.advanceTimersByTimeAsync(0);

      expect(slotsFake.refresh).not.toHaveBeenCalled();
      expect(media.opened).toEqual([]);
      expect(toasts.error).not.toHaveBeenCalled();
      await service.assign(1, 'cam-desk'); // and the service still works without it
      expect(service.assignments().get(1)?.deviceId).toBe('cam-desk');
    });
  });

  describe('leaving the page', () => {
    @Component({ template: '', changeDetection: ChangeDetectionStrategy.OnPush })
    class StreamingPageStub {
      readonly cameras = inject(CamerasService);
    }

    const pagehide = (persisted: boolean) =>
      window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted }));

    it('a publish survives navigating away from Streaming and is released on pagehide', async () => {
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

      const stops = posts('/api/mediasrc/stop');
      expect(stops).toHaveLength(1);
      expect(stops[0].init.keepalive).toBe(true);
      expect(JSON.parse(stops[0].init.body as string)).toEqual({
        index: 1,
        publisher_released: true,
        publisher_session: 'session-1',
      });
      expect(peerOf().closed).toBe(true);
      expect(streamOf().stopped).toBe(true);
      expect(deletes().map((call) => call.url)).toEqual([
        'https://insight.local:8889/cam1/whip/resource-1',
      ]);
      expect(service.localStreams().size).toBe(0);
    });

    it('a page that may come back from the back-forward cache keeps publishing', async () => {
      const service = await create();
      await publishDesk(service);

      pagehide(true);

      expect(posts('/api/mediasrc/stop')).toEqual([]);
      expect(peerOf().closed).toBe(false);
      expect(service.localStreams().has(1)).toBe(true);
    });

    it('sends no stop for a session it cannot name, and still closes it', async () => {
      const service = await create();
      whip = { status: 201, sessionId: null };
      await publishDesk(service);

      pagehide(false);

      expect(posts('/api/mediasrc/stop')).toEqual([]);
      expect(peerOf().closed).toBe(true);
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
