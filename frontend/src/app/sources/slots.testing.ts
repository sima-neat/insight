import type { Job, Slot, SlotList, SlotPublisher, SlotPull } from '../api.generated';

/** Slot answers for the specs, as `GET /api/slots` and the slot routes give them. */

/** Slot `n` with nothing assigned, stopped, as the server lists an unused slot. */
export function slot(n: number, overrides: Partial<Slot> = {}): Slot {
  return {
    n,
    kind: 'none',
    run: false,
    state: 'idle',
    readers: [],
    urls: { rtsp: `rtsp://10.0.0.2:8554/src${n}` },
    ...overrides,
  };
}

/** A file slot, stopped: H.264 at 30 fps unless `overrides` say otherwise. */
export function fileSlot(n: number, file: string, overrides: Partial<Slot> = {}): Slot {
  return slot(n, { kind: 'file', file, codec: 'h264', native_fps: 30, ...overrides });
}

/**
 * A webcam slot as the server answers its assignment: on, waiting for a browser to publish, at
 * 30 fps unless `overrides` says 60, with the publish URL of its rate.
 */
export function webcamSlot(n: number, overrides: Partial<Slot> = {}): Slot {
  const fps = overrides.fps ?? 30;
  const path = fps === 30 ? `cam${n}` : `cam${n}r${fps}`;
  return slot(n, {
    kind: 'webcam',
    run: true,
    fps,
    urls: { rtsp: `rtsp://10.0.0.2:8554/src${n}`, whip: `https://10.0.0.2:8889/${path}/whip` },
    ...overrides,
  });
}

/** A pulled camera, at `status` (live by default), as the server records it. */
export function pull(overrides: Partial<SlotPull> = {}): SlotPull {
  return { scheme: 'rtsp', host: '10.0.0.7:554', path: '/stream1', status: 'live', ...overrides };
}

/** The stream MediaMTX has for a slot. */
export function publisher(overrides: Partial<SlotPublisher> = {}): SlotPublisher {
  return {
    protocol: 'rtsp',
    address: '192.168.1.20',
    since: '2026-10-24T08:00:00Z',
    codec: 'h264',
    codec_supported: true,
    width: 1280,
    height: 720,
    fps: 30,
    bitrate_bps: 2_000_000,
    ...overrides,
  };
}

/** `GET /api/slots` for these slots. */
export function slotList(slots: readonly Slot[]): SlotList {
  return { count: 48, slots };
}

/** The 48 slots, each unassigned unless `assigned` holds it (by its `n`). */
export function slotsWith(...assigned: Slot[]): Slot[] {
  return Array.from(
    { length: 48 },
    (_, index) => assigned.find((one) => one.n === index + 1) ?? slot(index + 1),
  );
}

/** A job as the server reports it; running, at no percent yet, unless `overrides` say otherwise. */
export function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    kind: 'rendition',
    title: 'Encode walk.mp4 at 15 fps',
    state: 'running',
    progress: { phase: 'encode', detail: '' },
    created_at: '2026-11-18T22:00:00Z',
    ...overrides,
  };
}
