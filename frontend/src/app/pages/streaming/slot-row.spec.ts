import type { Slot, SlotExternal, SlotPull } from '../../sources/api';
import {
  formatBitrate,
  isInUse,
  isLive,
  liveFor,
  previewSrc,
  pullSourceText,
  readersText,
  slotOutput,
  slotRow,
  streamUrl,
} from './slot-row';

function slot(index: number, overrides: Partial<Slot> = {}): Slot {
  return {
    index,
    file: '',
    state: 'stopped',
    transport: '',
    codec: '',
    type: 'file',
    allowed_transports: [],
    urls: {},
    ...overrides,
  };
}

const external = (overrides: Partial<SlotExternal> = {}): SlotExternal => ({
  protocol: 'rtsp',
  address: '192.168.1.20:41234',
  since: '2026-10-24T08:00:00Z',
  codec_supported: true,
  width: 1280,
  height: 720,
  fps: 30,
  bitrate_bps: 2_000_000,
  ...overrides,
});

const pull = (overrides: Partial<SlotPull> = {}): SlotPull => ({
  status: 'live',
  scheme: 'rtsp',
  host: '10.0.0.7:554',
  path: '/stream1',
  error: null,
  since: '2026-10-24T08:00:00Z',
  codec_supported: true,
  width: 1920,
  height: 1080,
  fps: 25,
  bitrate_bps: 4_000_000,
  ...overrides,
});

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
    expect(columns(slotRow(slot(1, { codec: 'unknown' })))).toEqual([
      'src1',
      '',
      'Not assigned',
      'Idle (neutral)',
      '',
      '-',
    ]);
  });

  it('a file slot: VID, the file, Live or Idle, its rate and codec', () => {
    const playing = slot(2, {
      file: 'catalog/people/walk_720p30.mp4',
      state: 'playing',
      codec: 'h264',
      native_fps: 30,
      fps: null,
    });
    expect(columns(slotRow(playing))).toEqual([
      'src2',
      'VID',
      'catalog/people/walk_720p30.mp4',
      'Live (success)',
      '30 fps',
      'H.264',
    ]);
    expect(columns(slotRow({ ...playing, state: 'stopped', codec: 'h265' }))).toEqual([
      'src2',
      'VID',
      'catalog/people/walk_720p30.mp4',
      'Idle (neutral)',
      '30 fps',
      'H.265',
    ]);
  });

  it('a file slot at a rate of its own says it streams a rendition', () => {
    const row = slotRow(slot(3, { file: 'a.mp4', codec: 'h264', native_fps: 25, fps: 15 }));
    expect(row.rate).toBe('15 fps · rendition');
    // The file's own rate set explicitly is no rendition, and an unprobed file has no rate yet.
    expect(slotRow(slot(3, { file: 'a.mp4', native_fps: 25, fps: 25 })).rate).toBe('25 fps');
    expect(slotRow(slot(3, { file: 'a.mp4', native_fps: null, fps: null })).rate).toBe('');
    expect(slotRow(slot(3, { file: 'a.mp4', codec: 'unknown' })).codec).toBe('Unknown');
    expect(slotRow(slot(3, { file: 'a.mp4', codec: '' })).codec).toBe('-');
  });

  it('a slot whose rendition is encoding: Encoding, and the percent as its rate', () => {
    const file = slot(4, { file: 'a.mp4', codec: 'h264', native_fps: 25, fps: 15 });
    const row = slotRow(file, {
      encode: { title: 'Encoding 15 fps rendition…', detail: 'libx264', percent: 42 },
    });
    expect(`${row.state.label} (${row.state.tone})`).toBe('Encoding (info)');
    expect(row.rate).toBe('encoding 42%');
    // Before the server has said how long it takes.
    expect(
      slotRow(file, { encode: { title: 'Preparing rendition…', detail: '', percent: null } }).rate,
    ).toBe('encoding');
  });

  it('a webcam slot: CAM and the camera this browser picked, else "Select a camera"', () => {
    const webcam = slot(5, { type: 'webcam', codec: 'h264', transport: 'rtsp' });
    expect(columns(slotRow(webcam, { camera: { deviceId: 'd1', label: 'Desk camera' } }))).toEqual([
      'src5',
      'CAM',
      'Desk camera',
      'Idle (neutral)',
      '',
      'H.264',
    ]);
    expect(slotRow({ ...webcam, state: 'playing' }).source).toBe('Select a camera');
    expect(slotRow({ ...webcam, state: 'playing' }).state.label).toBe('Live');
  });

  it('an external slot: EXT, the publisher chip, External, its rate and codec', () => {
    expect(
      columns(slotRow(slot(6, { state: 'external', codec: 'h264', external: external() }))),
    ).toEqual([
      'src6',
      'EXT',
      '⇢ RTSP · 192.168.1.20:41234 · 1280×720 · 30 fps',
      'External (info)',
      '30 fps',
      'H.264',
    ]);
    // What is not known yet is left out of the chip rather than shown empty.
    const unprobed = slotRow(
      slot(6, {
        state: 'external',
        codec: 'h264',
        external: external({ protocol: 'webrtc', address: null, width: null, fps: null }),
      }),
    );
    expect(unprobed.source).toBe('⇢ WebRTC');
    expect(unprobed.rate).toBe('');
    // #170's names for the protocols; one it does not know reads in capitals, none as "-".
    const via = (protocol: string) =>
      slotRow(slot(6, { state: 'external', external: external({ protocol, address: null }) }))
        .source;
    expect([via('rtsps'), via('srt'), via('rtmp'), via('mpegts'), via('')]).toEqual([
      '⇢ RTSPS · 1280×720 · 30 fps',
      '⇢ SRT · 1280×720 · 30 fps',
      '⇢ RTMP · 1280×720 · 30 fps',
      '⇢ MPEGTS · 1280×720 · 30 fps',
      '⇢ - · 1280×720 · 30 fps',
    ]);
  });

  it('an external slot keeps showing as external over a file or webcam assignment under it', () => {
    const held = slot(7, {
      type: 'webcam',
      file: '',
      state: 'external',
      codec: 'h264',
      external: external(),
    });
    expect(slotRow(held).kind).toBe('EXT');
    expect(slotRow(held, { camera: { deviceId: 'd1', label: 'Desk' } }).source).toContain('⇢');
  });

  it('warns of a codec Neat pipelines cannot decode', () => {
    const row = slotRow(
      slot(8, { state: 'external', codec: 'av1', external: external({ codec_supported: false }) }),
    );
    expect(row.codec).toBe('AV1');
    expect(row.codecWarning).toBe(
      'AV1 cannot be decoded by Neat video pipelines (expects H.264, H.265 or MJPEG). Readers can connect, but decoding will fail.',
    );
    expect(slotRow(slot(8, { file: 'a.mp4', codec: 'h264' })).codecWarning).toBeNull();
    // A pull warns only while live: until then there is no stream to judge.
    const pulled = (status: SlotPull['status']) =>
      slotRow(
        slot(8, { state: 'pulled', codec: 'vp9', pull: pull({ status, codec_supported: false }) }),
      ).codecWarning;
    expect(pulled('live')).toContain('VP9 cannot be decoded');
    expect(pulled('connecting')).toBeNull();
  });

  it('a pulled slot: URL, its state per pull status, the pull chip naming the camera, and rate', () => {
    const pulled = (overrides: Partial<SlotPull>, codec = 'h264') =>
      columns(
        slotRow(slot(9, { file: 'under.mp4', state: 'pulled', codec, pull: pull(overrides) })),
      );
    expect(pulled({})).toEqual([
      'src9',
      'URL',
      '⇠ RTSP · 10.0.0.7:554 · 1920×1080 · 25 fps',
      'Pulled (success)',
      '25 fps',
      'H.264',
    ]);
    expect(pulled({ status: 'connecting', fps: null, width: null }, 'none')).toEqual([
      'src9',
      'URL',
      '⇠ RTSP · 10.0.0.7:554 · connecting…',
      'Connecting… (neutral)',
      '',
      '-',
    ]);
    expect(pulled({ status: 'unreachable', error: 'connection refused' }, 'none')).toEqual([
      'src9',
      'URL',
      '⇠ RTSP · 10.0.0.7:554 · retrying… (connection refused)',
      'Unreachable (warning)',
      'retrying…',
      '-',
    ]);
    expect(
      pulled(
        { status: 'auth_failed', error: 'The camera rejected the username or password' },
        'none',
      ),
    ).toEqual([
      'src9',
      'URL',
      '⇠ RTSP · 10.0.0.7:554 · The camera rejected the username or password',
      'Auth failed (danger)',
      '',
      '-',
    ]);
    // What is not known reads as #170 shows it.
    const bare = slotRow(
      slot(9, {
        state: 'pulled',
        pull: pull({ status: 'auth_failed', scheme: 'rtsps', host: '', error: null }),
      }),
    );
    expect(bare.source).toBe('⇠ RTSPS · - · Auth failed');
    expect(
      slotRow(slot(9, { state: 'pulled', pull: pull({ status: 'unreachable', error: null }) }))
        .source,
    ).toBe('⇠ RTSP · 10.0.0.7:554 · retrying…');
  });
});

describe('isInUse', () => {
  it('counts assigned, external and pulled slots', () => {
    expect(isInUse(slot(1))).toBe(false);
    expect(isInUse(slot(1, { codec: 'unknown' }))).toBe(false);
    expect(isInUse(slot(1, { file: 'a.mp4' }))).toBe(true);
    expect(isInUse(slot(1, { type: 'webcam' }))).toBe(true);
    expect(isInUse(slot(1, { state: 'external', external: external() }))).toBe(true);
    expect(isInUse(slot(1, { state: 'pulled', pull: pull() }))).toBe(true);
  });
});

// #170's `externalSource.test.js` cases for these helpers, with their assertions unchanged except
// that the preview has no on/off switch any more (so no `enabled` argument).
describe('preview, live-for, bitrate, readers and pull source', () => {
  it('preview src carries a remount token', () => {
    expect(previewSrc(2, 1737000000000)).toBe('/stream/preview/src2.mjpg?t=1737000000000');
  });

  it('preview src changes with the publisher session so a reconnect remounts the image', () => {
    const first = previewSrc(2, 1, '2026-09-16T13:10:00.000000000Z');
    const second = previewSrc(2, 1, '2026-09-16T13:10:07.000000000Z');
    expect(first).toBe('/stream/preview/src2.mjpg?t=1&s=2026-09-16T13%3A10%3A00.000000000Z');
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
    expect(readersText(undefined)).toBe('0');
  });

  it('pull source text never includes credentials', () => {
    expect(pullSourceText(pull({ host: '172.18.51.40:554', path: '/h264Preview_01_main' }))).toBe(
      'rtsp://172.18.51.40:554/h264Preview_01_main',
    );
    expect(pullSourceText(pull({ scheme: 'rtsps', host: 'cam:322', path: '' }))).toBe(
      'rtsps://cam:322',
    );
  });
});

describe('isLive', () => {
  it('is true for a playing slot, an external publisher and a pull that is live', () => {
    expect(isLive(slot(1, { file: 'a.mp4', state: 'playing' }))).toBe(true);
    expect(isLive(slot(1, { type: 'webcam', state: 'playing' }))).toBe(true);
    expect(isLive(slot(1, { state: 'external', external: external() }))).toBe(true);
    expect(isLive(slot(1, { state: 'pulled', pull: pull({ status: 'live' }) }))).toBe(true);
    expect(isLive(slot(1, { file: 'a.mp4' }))).toBe(false);
    expect(isLive(slot(1, { state: 'pulled', pull: pull({ status: 'unreachable' }) }))).toBe(false);
  });
});

describe('streamUrl', () => {
  it('is the RTSP URL the server reports, or the HTTP MJPEG one for an HTTP slot (#170)', () => {
    const urls = { rtsp: 'rtsp://10.0.0.2:8554/src3', http_mjpeg: 'http://10.0.0.2/s/src3.mjpg' };
    expect(streamUrl(slot(3, { transport: 'rtsp', urls }))).toBe('rtsp://10.0.0.2:8554/src3');
    expect(streamUrl(slot(3, { transport: 'http', urls }))).toBe('http://10.0.0.2/s/src3.mjpg');
    expect(streamUrl(slot(3, { transport: 'http', urls: {} }))).toBe('/stream/http/src3.mjpg');
    expect(streamUrl(slot(3, { urls: {} }))).toBeNull();
  });
});

describe('slotOutput', () => {
  it("names the transport, the codec and the rate a file slot streams at (#170's Output line)", () => {
    expect(
      slotOutput(slot(1, { file: 'a.mp4', transport: 'rtsp', codec: 'h264', native_fps: 25 })),
    ).toBe('RTSP / H.264 · 25 fps');
    expect(
      slotOutput(
        slot(1, { file: 'a.mp4', transport: 'rtsp', codec: 'h264', native_fps: 25, fps: 15 }),
      ),
    ).toBe('RTSP / H.264 · 15 fps');
    expect(slotOutput(slot(1, { file: 'a.mjpeg', transport: 'http', codec: 'mjpeg' }))).toBe(
      'HTTP / MJPEG',
    );
    expect(slotOutput(slot(1, { file: 'a.bin', codec: 'unknown' }))).toBe('- / Unknown');
    expect(slotOutput(slot(1, { type: 'webcam', transport: 'rtsp', codec: 'h264' }))).toBe(
      'RTSP / H.264',
    );
  });
});
