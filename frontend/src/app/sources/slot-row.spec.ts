import type { Slot, SlotPull } from '../api.generated';
import {
  codecLabel,
  formatBitrate,
  isInUse,
  isLive,
  isRunning,
  liveFor,
  previewSrc,
  pullSourceText,
  pullStatusLabel,
  readersText,
  slotOutput,
  type SlotRow,
  slotRow,
} from './slot-row';
import { fileSlot, publisher, pull, slot, webcamSlot } from './slots.testing';

/** A slot an external publisher holds. */
const external = (n: number, overrides: Partial<Slot> = {}): Slot =>
  slot(n, { state: 'external', codec: 'h264', publisher: publisher(), ...overrides });

/** A slot that pulls a camera, at the pull's status, with the stream MediaMTX has while live. */
const pulled = (n: number, overrides: Partial<SlotPull> = {}, codec = 'h264'): Slot => {
  const status = overrides.status ?? 'live';
  const live = status === 'live';
  return slot(n, {
    kind: 'pull',
    run: status !== 'stopped' && status !== 'needs_credentials',
    state: live ? 'live' : status === 'auth_failed' ? 'failed' : 'starting',
    pull: pull(overrides),
    ...(live
      ? {
          codec,
          publisher: publisher({
            protocol: 'rtspSource',
            address: undefined,
            width: 1920,
            height: 1080,
            fps: 25,
          }),
        }
      : {}),
  });
};

/** The row as the list shows it: one string per column, the state as label and tone. */
const columns = (row: ReturnType<typeof slotRow>) => [
  row.name,
  row.kind,
  row.source,
  `${row.state.label} (${row.state.tone})`,
  row.rate,
  row.codec,
];

describe('slotRow', () => {
  it('an unassigned slot: no kind, "Not assigned", Idle, no rate, "-" for the codec', () => {
    expect(columns(slotRow(slot(1)))).toEqual([
      'src1',
      '',
      'Not assigned',
      'Idle (neutral)',
      '',
      '-',
    ]);
  });

  it('a file slot: VID, the file, Live, Starting… or Idle, its rate and codec', () => {
    const live = fileSlot(2, 'catalog/people/walk_720p30.mp4', { run: true, state: 'live' });
    expect(columns(slotRow(live))).toEqual([
      'src2',
      'VID',
      'catalog/people/walk_720p30.mp4',
      'Live (success)',
      '30 fps',
      'H.264',
    ]);
    expect(columns(slotRow({ ...live, run: false, state: 'idle', codec: 'h265' }))).toEqual([
      'src2',
      'VID',
      'catalog/people/walk_720p30.mp4',
      'Idle (neutral)',
      '30 fps',
      'H.265',
    ]);
    expect(slotRow({ ...live, state: 'starting' }).state.label).toBe('Starting…');
  });

  it('a file slot that failed says so, in the danger tone', () => {
    const failed = fileSlot(2, 'a.mp4', {
      run: true,
      state: 'failed',
      error: 'The stream stopped.',
    });
    expect(`${slotRow(failed).state.label} (${slotRow(failed).state.tone})`).toBe(
      'Failed (danger)',
    );
  });

  it('a file slot at a rate of its own says it streams a rendition', () => {
    const row = slotRow(fileSlot(3, 'a.mp4', { native_fps: 25, fps: 15 }));
    expect(row.rate).toBe('15 fps · rendition');
    // The file's own rate set explicitly is no rendition, and an unprobed file has no rate yet.
    expect(slotRow(fileSlot(3, 'a.mp4', { native_fps: 25, fps: 25 })).rate).toBe('25 fps');
    expect(slotRow(fileSlot(3, 'a.mp4', { native_fps: undefined })).rate).toBe('');
    // A rate set before the file's own is known is a rendition too: the start encodes it.
    expect(slotRow(fileSlot(3, 'a.mp4', { native_fps: undefined, fps: 15 })).rate).toBe(
      '15 fps · rendition',
    );
    expect(slotRow(fileSlot(3, 'a.mp4', { codec: 'unknown' })).codec).toBe('Unknown');
    expect(slotRow(fileSlot(3, 'a.mp4', { codec: undefined })).codec).toBe('-');
  });

  it('a preparing slot: Encoding, and the percent of its encode as its rate', () => {
    const preparing = fileSlot(4, 'a.mp4', {
      native_fps: 25,
      fps: 15,
      run: true,
      state: 'preparing',
      job: 'job-1',
    });
    const row = slotRow(preparing, {
      encode: { title: 'Encoding rendition…', detail: '00:25 / 01:00', percent: 42 },
    });
    expect(`${row.state.label} (${row.state.tone})`).toBe('Encoding (info)');
    expect(row.rate).toBe('encoding 42%');
    // Before the encode's first event.
    expect(
      slotRow(preparing, { encode: { title: 'Encoding rendition…', detail: '', percent: null } })
        .rate,
    ).toBe('encoding');
    // Preparing is Encoding even before the service has an encode for it.
    expect(slotRow(preparing).state.label).toBe('Encoding');
  });

  it('a slot whose start is in flight is Starting… until the server says more; other states keep their own', () => {
    const idle = fileSlot(4, 'a.mp4');
    const label = (row: SlotRow) => `${row.state.label} (${row.state.tone})`;
    expect(label(slotRow(idle, { starting: true }))).toBe('Starting… (info)');
    expect(label(slotRow(idle, { starting: false }))).toBe('Idle (neutral)');
    expect(label(slotRow(idle))).toBe('Idle (neutral)');

    // Live already: the start has landed and only its bookkeeping is still running.
    expect(label(slotRow({ ...idle, run: true, state: 'live' }, { starting: true }))).toBe(
      'Live (success)',
    );
    // An encode is Encoding, and a publisher is what holds the slot.
    const encode = { title: 'Encoding rendition…', detail: '', percent: 10 };
    expect(label(slotRow(idle, { starting: true, encode }))).toBe('Encoding (info)');
    expect(label(slotRow(external(4), { starting: true }))).toBe('External (highlight)');
  });

  it('a webcam slot: CAM and the camera this browser picked, else "Select a camera"', () => {
    const webcam = webcamSlot(5);
    expect(columns(slotRow(webcam, { camera: { deviceId: 'd1', label: 'Desk camera' } }))).toEqual([
      'src5',
      'CAM',
      'Desk camera',
      'Idle (neutral)',
      '',
      '-',
    ]);
    const live = { ...webcam, state: 'live' as const, codec: 'h264', publisher: publisher() };
    expect(slotRow(live).source).toBe('Select a camera');
    expect(slotRow(live).state.label).toBe('Live');
    expect(slotRow(live).codec).toBe('H.264');
  });

  it('an external slot: EXT, the publisher chip, External, its rate and codec', () => {
    expect(columns(slotRow(external(6)))).toEqual([
      'src6',
      'EXT',
      '⇢ RTSP · 192.168.1.20 · 1280×720 · 30 fps',
      'External (highlight)',
      '30 fps',
      'H.264',
    ]);
    // What is not known yet is left out of the chip rather than shown empty.
    const unprobed = slotRow(
      external(6, {
        publisher: publisher({
          protocol: 'webrtc',
          address: undefined,
          width: undefined,
          fps: undefined,
        }),
      }),
    );
    expect(unprobed.source).toBe('⇢ WebRTC');
    expect(unprobed.rate).toBe('');
    // A measured rate reads as whole frames.
    expect(slotRow(external(6, { publisher: publisher({ fps: 29.97 }) })).rate).toBe('30 fps');
    // #170's names for the protocols; one it does not know reads in capitals, none as "-".
    const via = (protocol: string) =>
      slotRow(external(6, { publisher: publisher({ protocol, address: undefined }) })).source;
    expect([via('rtsps'), via('srt'), via('rtmp'), via('mpegts'), via('')]).toEqual([
      '⇢ RTSPS · 1280×720 · 30 fps',
      '⇢ SRT · 1280×720 · 30 fps',
      '⇢ RTMP · 1280×720 · 30 fps',
      '⇢ MPEGTS · 1280×720 · 30 fps',
      '⇢ - · 1280×720 · 30 fps',
    ]);
  });

  it('an external slot keeps showing as external over a file or webcam assignment under it', () => {
    const held = external(7, { kind: 'webcam', run: true });
    expect(slotRow(held).kind).toBe('EXT');
    expect(slotRow(held, { camera: { deviceId: 'd1', label: 'Desk' } }).source).toContain('⇢');
    expect(slotRow(external(7, { kind: 'file', file: 'a.mp4' })).kind).toBe('EXT');
  });

  it('warns of a codec Neat pipelines cannot decode', () => {
    const row = slotRow(
      external(8, { codec: 'av1', publisher: publisher({ codec: 'av1', codec_supported: false }) }),
    );
    expect(row.codec).toBe('AV1');
    expect(row.codecWarning).toBe(
      'AV1 cannot be decoded by Neat video pipelines (expects H.264, H.265 or MJPEG). Readers can connect, but decoding will fail.',
    );
    expect(slotRow(fileSlot(8, 'a.mp4')).codecWarning).toBeNull();
    // A pull warns only while live: until then there is no stream to judge.
    const live = pulled(8, {}, 'vp9');
    expect(
      slotRow({ ...live, publisher: { ...live.publisher!, codec_supported: false } }).codecWarning,
    ).toContain('VP9 cannot be decoded');
    expect(slotRow(pulled(8, { status: 'connecting' })).codecWarning).toBeNull();
  });

  it('a pull slot: URL, its state per pull status, the pull chip naming the camera, and rate', () => {
    const row = (overrides: Partial<SlotPull>) => columns(slotRow(pulled(9, overrides)));
    expect(row({})).toEqual([
      'src9',
      'URL',
      '⇠ RTSP · 10.0.0.7:554 · 1920×1080 · 25 fps',
      'Live (success)',
      '25 fps',
      'H.264',
    ]);
    expect(row({ status: 'connecting' })).toEqual([
      'src9',
      'URL',
      '⇠ RTSP · 10.0.0.7:554 · connecting…',
      'Connecting… (info)',
      '',
      '-',
    ]);
    expect(row({ status: 'unreachable', error: 'connection refused' })).toEqual([
      'src9',
      'URL',
      '⇠ RTSP · 10.0.0.7:554 · retrying… (connection refused)',
      'Unreachable (warning)',
      'retrying…',
      '-',
    ]);
    expect(
      row({ status: 'auth_failed', error: 'The camera rejected the username or password' }),
    ).toEqual([
      'src9',
      'URL',
      '⇠ RTSP · 10.0.0.7:554 · The camera rejected the username or password',
      'Auth failed (danger)',
      '',
      '-',
    ]);
    // Stopped, it keeps its camera; after a restart it needs its URL again.
    expect(row({ status: 'stopped' })).toEqual([
      'src9',
      'URL',
      '⇠ RTSP · 10.0.0.7:554 · stopped',
      'Idle (neutral)',
      '',
      '-',
    ]);
    expect(row({ status: 'needs_credentials' })).toEqual([
      'src9',
      'URL',
      '⇠ RTSP · 10.0.0.7:554 · stream URL needed again',
      'Needs URL (warning)',
      '',
      '-',
    ]);
    // What is not known reads as #170 shows it.
    expect(
      slotRow(pulled(9, { status: 'auth_failed', scheme: 'rtsps', host: '', error: undefined }))
        .source,
    ).toBe('⇠ RTSPS · - · Auth failed');
    expect(slotRow(pulled(9, { status: 'unreachable' })).source).toBe(
      '⇠ RTSP · 10.0.0.7:554 · retrying…',
    );
    // A stopped pull that is being started reads Starting….
    expect(slotRow(pulled(9, { status: 'stopped' }), { starting: true }).state.label).toBe(
      'Starting…',
    );
  });
});

describe('isInUse', () => {
  it('counts assigned slots of every kind and external ones', () => {
    expect(isInUse(slot(1))).toBe(false);
    expect(isInUse(fileSlot(1, 'a.mp4'))).toBe(true);
    expect(isInUse(webcamSlot(1))).toBe(true);
    expect(isInUse(pulled(1))).toBe(true);
    expect(isInUse(external(1))).toBe(true);
  });
});

describe('isRunning', () => {
  it('is the user’s Start for a file and a pull, and a browser publishing for a webcam', () => {
    expect(isRunning(fileSlot(1, 'a.mp4'))).toBe(false);
    expect(isRunning(fileSlot(1, 'a.mp4', { run: true, state: 'preparing' }))).toBe(true);
    expect(isRunning(fileSlot(1, 'a.mp4', { run: true, state: 'failed' }))).toBe(true);
    expect(isRunning(pulled(1))).toBe(true);
    expect(isRunning(pulled(1, { status: 'stopped' }))).toBe(false);
    // The server keeps a webcam slot on from its assignment: only a publisher makes it run.
    expect(isRunning(webcamSlot(1))).toBe(false);
    expect(isRunning(webcamSlot(1, { state: 'starting' }))).toBe(true);
    expect(isRunning(webcamSlot(1, { state: 'live' }))).toBe(true);
  });
});

// #170's `externalSource.test.js` cases for these helpers, with their assertions unchanged except
// that the preview has no on/off switch any more (so no `enabled` argument) and is the server's
// own route.
describe('preview, live-for, bitrate, readers and pull source', () => {
  it('preview src carries a remount token', () => {
    expect(previewSrc(2, 1737000000000)).toBe('/api/slots/2/preview.mjpg?t=1737000000000');
  });

  it('preview src changes with the publisher session so a reconnect remounts the image', () => {
    const first = previewSrc(2, 1, '2026-09-16T13:10:00.000000000Z');
    const second = previewSrc(2, 1, '2026-09-16T13:10:07.000000000Z');
    expect(first).toBe('/api/slots/2/preview.mjpg?t=1&s=2026-09-16T13%3A10%3A00.000000000Z');
    expect(first).not.toBe(second);
  });

  it('live-for, bitrate and readers formatting', () => {
    const t0 = Date.parse('2026-09-16T13:09:59Z');
    expect(liveFor('2026-09-16T13:09:59Z', t0 + 724000)).toBe('12m 04s');
    expect(liveFor('2026-09-16T13:09:59Z', t0 + 3720000)).toBe('1h 02m');
    expect(liveFor(null, t0)).toBe('-');
    expect(formatBitrate(1800000)).toBe('1.8 Mbit/s');
    expect(formatBitrate(850000)).toBe('850 kbit/s');
    expect(formatBitrate(null)).toBe('-');
    expect(
      readersText([
        { protocol: 'rtsp', address: '10.42.0.79' },
        { protocol: 'rtsp', address: '127.0.0.1', label: 'insight preview' },
      ]),
    ).toBe('2 · 10.42.0.79, insight preview');
    expect(readersText([])).toBe('0');
  });

  it('pull source text never includes credentials', () => {
    expect(pullSourceText(pull({ host: '172.18.51.40:554', path: '/h264Preview_01_main' }))).toBe(
      'rtsp://172.18.51.40:554/h264Preview_01_main',
    );
    expect(pullSourceText(pull({ scheme: 'rtsps', host: 'cam:322', path: '' }))).toBe(
      'rtsps://cam:322',
    );
  });

  it('names each pull status as the details say it', () => {
    const statuses: SlotPull['status'][] = [
      'live',
      'connecting',
      'unreachable',
      'auth_failed',
      'needs_credentials',
      'stopped',
    ];
    expect(statuses.map((status) => pullStatusLabel(pull({ status })))).toEqual([
      'Live',
      'Connecting…',
      'Unreachable',
      'Auth failed',
      'Needs URL',
      'Stopped',
    ]);
  });
});

describe('isLive', () => {
  it('is true while MediaMTX has the stream: live, or held by an external publisher', () => {
    expect(isLive(fileSlot(1, 'a.mp4', { run: true, state: 'live' }))).toBe(true);
    expect(isLive(webcamSlot(1, { state: 'live' }))).toBe(true);
    expect(isLive(external(1))).toBe(true);
    expect(isLive(pulled(1))).toBe(true);
    expect(isLive(fileSlot(1, 'a.mp4'))).toBe(false);
    expect(isLive(fileSlot(1, 'a.mp4', { run: true, state: 'starting' }))).toBe(false);
    expect(isLive(pulled(1, { status: 'unreachable' }))).toBe(false);
  });
});

describe('slotOutput', () => {
  it("names the protocols, the codec and the rate a file slot streams at (#170's Output line)", () => {
    expect(slotOutput(fileSlot(1, 'a.mp4', { native_fps: 25 }))).toBe('RTSP / H.264 · 25 fps');
    expect(slotOutput(fileSlot(1, 'a.mp4', { native_fps: 25, fps: 15 }))).toBe(
      'RTSP / H.264 · 15 fps',
    );
    // An MJPEG stream also goes out over HTTP.
    expect(
      slotOutput(
        fileSlot(1, 'a.mjpeg', {
          codec: 'mjpeg',
          native_fps: undefined,
          urls: { rtsp: 'rtsp://h/src1', http_mjpeg: 'https://h/stream/http/src1.mjpg' },
        }),
      ),
    ).toBe('RTSP and HTTP / MJPEG');
    expect(slotOutput(fileSlot(1, 'a.bin', { codec: 'unknown', native_fps: undefined }))).toBe(
      'RTSP / Unknown',
    );
    expect(slotOutput(webcamSlot(1, { codec: 'h264' }))).toBe('RTSP / H.264');
  });
});

describe('codecLabel', () => {
  it("names the codecs Insight streams, the catalog's hevc as H.265, and others in capitals", () => {
    expect(['h264', 'h265', 'hevc', 'mjpeg', 'av1', '', undefined].map(codecLabel)).toEqual([
      'H.264',
      'H.265',
      'H.265',
      'MJPEG',
      'AV1',
      '-',
      '-',
    ]);
  });
});
