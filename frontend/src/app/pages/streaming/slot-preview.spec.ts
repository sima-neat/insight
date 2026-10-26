import { HttpClient, HttpHeaderResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import type { Slot, SlotPull } from '../../sources/api';
import { previewFailure, SlotPreview } from './slot-preview';

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

@Component({
  imports: [SlotPreview],
  template: `@if (shown()) {
    <app-slot-preview [slot]="slot()" [localStream]="stream()" />
  }`,
})
class Host {
  readonly shown = signal(true);
  readonly slot = signal<Slot>(slot(1));
  readonly stream = signal<MediaStream | null>(null);
}

describe('SlotPreview', () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;
  let http: HttpTestingController;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(1_737_000_000_000);
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    vi.useRealTimers();
  });

  async function show(value: Slot, stream: MediaStream | null = null): Promise<void> {
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    host.slot.set(value);
    host.stream.set(stream);
    await fixture.whenStable();
  }

  const root = (): HTMLElement => fixture.nativeElement;
  const text = () => root().textContent!.replace(/\s+/g, ' ').trim();
  const image = () => root().querySelector('img');
  const video = () => root().querySelector('video');
  const button = (label: string) =>
    [...root().querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!;

  /** What the browser does once the multipart stream's first frame is decoded. */
  function decodeFirstFrame(img: HTMLImageElement): void {
    Object.defineProperty(img, 'naturalWidth', { configurable: true, value: 1280 });
  }

  it('the preview shows the stream when live, the file when not, and the 429 message with Retry', async () => {
    // A file slot that is not live shows the file itself, labelled as the file.
    await show(slot(1, { file: 'people/walk 1.mp4', codec: 'h264' }));
    expect(video()!.getAttribute('src')).toBe('/media/people/walk%201.mp4');
    expect(text()).toContain('File preview');

    // Live: the slot's stream, connecting until the first frame shows.
    host.slot.set(slot(1, { file: 'people/walk 1.mp4', codec: 'h264', state: 'playing' }));
    await fixture.whenStable();
    expect(video()).toBeNull();
    const live = image()!;
    expect(live.getAttribute('src')).toBe('/stream/preview/src1.mjpg?t=1737000000000');
    expect(live.getAttribute('alt')).toBe('Live preview of src1');
    expect(text()).toContain('Connecting to src1…');
    expect(root().querySelector('neat-progress')).not.toBeNull();
    vi.advanceTimersByTime(300);
    await fixture.whenStable();
    expect(text()).toContain('Connecting to src1…');
    decodeFirstFrame(live);
    vi.advanceTimersByTime(100);
    await fixture.whenStable();
    expect(text()).not.toContain('Connecting');
    expect(root().querySelector('neat-progress')).toBeNull();
    expect(text()).not.toContain('File preview');

    // The server's cap on previews refuses a new stream: it says so and offers a fresh attempt.
    host.slot.set(slot(2, { state: 'playing', file: 'cars.mp4', codec: 'h264' }));
    await fixture.whenStable();
    image()!.dispatchEvent(new Event('error'));
    await fixture.whenStable();
    http
      .expectOne((request) => request.url.startsWith('/stream/preview/src2.mjpg'))
      .flush({ error: 'Too many previews open' }, { status: 429, statusText: 'Too Many Requests' });
    await fixture.whenStable();
    expect(image()).toBeNull();
    expect(text()).toContain('Preview unavailable: too many previews open');

    vi.setSystemTime(1_737_000_005_000);
    button('Retry').click();
    await fixture.whenStable();
    expect(image()!.getAttribute('src')).toBe('/stream/preview/src2.mjpg?t=1737000005000');
    expect(text()).toContain('Connecting to src2…');
  });

  it('another failure says the preview is unavailable, with Retry', async () => {
    await show(slot(2, { state: 'pulled', pull: pull() }));
    expect(image()!.getAttribute('src')).toBe(
      '/stream/preview/src2.mjpg?t=1737000000000&s=2026-10-24T08%3A00%3A00Z',
    );
    image()!.dispatchEvent(new Event('error'));
    await fixture.whenStable();
    http
      .expectOne((request) => request.url.startsWith('/stream/preview/src2.mjpg'))
      .flush({ error: 'Source is not live' }, { status: 409, statusText: 'Conflict' });
    await fixture.whenStable();
    expect(text()).toContain('Preview unavailable.');
    expect(text()).not.toContain('too many');
    expect(button('Retry')).toBeDefined();
  });

  it('a failure the second request does not repeat is still reported as unavailable, and the request is dropped', async () => {
    await show(slot(2, { state: 'external' }));
    image()!.dispatchEvent(new Event('error'));
    await fixture.whenStable();
    const probe = http.expectOne((request) => request.url.startsWith('/stream/preview/src2.mjpg'));
    // The stream answers this time: only its status was wanted, so the request ends there.
    probe.event(new HttpHeaderResponse({ status: 200, statusText: 'OK' }));
    await fixture.whenStable();
    expect(probe.cancelled).toBe(true);
    expect(text()).toContain('Preview unavailable.');
  });

  it('shows the file by its kind: MJPEG through the preview route, an image as itself', async () => {
    await show(slot(1, { file: 'clips/cam.mjpeg', codec: 'mjpeg', transport: 'http' }));
    expect(image()!.getAttribute('src')).toBe('/api/media-preview/mjpeg?path=clips%2Fcam.mjpeg');
    expect(text()).toContain('File preview');

    host.slot.set(slot(1, { file: 'stills/a.jpg', codec: 'mjpeg' }));
    await fixture.whenStable();
    // The streamer reads a JPEG as MJPEG, so it previews through the same route (#170).
    expect(image()!.getAttribute('src')).toBe('/api/media-preview/mjpeg?path=stills%2Fa.jpg');

    host.slot.set(slot(1, { file: 'stills/b.png', codec: 'unknown' }));
    await fixture.whenStable();
    expect(image()!.getAttribute('src')).toBe('/media/stills/b.png');
  });

  it('says what there is to see when nothing is live', async () => {
    await show(slot(1));
    expect(text()).toBe('Assign a media file to preview.');

    host.slot.set(slot(1, { type: 'webcam' }));
    await fixture.whenStable();
    expect(text()).toBe('Start this source to preview the live webcam.');

    host.slot.set(
      slot(1, {
        state: 'pulled',
        pull: pull({ status: 'unreachable', error: 'connection refused', since: null }),
      }),
    );
    await fixture.whenStable();
    expect(text()).toBe('Waiting for the camera… (connection refused)');

    host.slot.set(
      slot(1, {
        state: 'pulled',
        pull: pull({
          status: 'auth_failed',
          error: 'The camera rejected the username or password',
        }),
      }),
    );
    await fixture.whenStable();
    expect(text()).toBe('The camera rejected the username or password');
    expect(image()).toBeNull();
  });

  it('a webcam this browser publishes shows its own camera until the slot is live', async () => {
    const stream = {} as MediaStream;
    await show(slot(3, { type: 'webcam' }), stream);
    expect(video()!.srcObject).toBe(stream);
    expect(image()).toBeNull();

    host.slot.set(slot(3, { type: 'webcam', state: 'playing' }));
    await fixture.whenStable();
    expect(video()).toBeNull();
    expect(image()!.getAttribute('src')).toBe('/stream/preview/src3.mjpg?t=1737000000000');
  });

  it('ends a live or MJPEG image’s stream when the image goes, since a browser would keep it loading', async () => {
    await show(slot(1, { state: 'external' }));
    const first = image()!;
    host.slot.set(slot(4, { state: 'external' }));
    await fixture.whenStable();
    expect(first.hasAttribute('src')).toBe(false);
    expect(image()!.getAttribute('src')).toContain('/stream/preview/src4.mjpg');

    // A Retry is a new image, and the failed one is let go.
    const second = image()!;
    host.slot.set(slot(4, { file: 'cam.mjpeg', codec: 'mjpeg' }));
    await fixture.whenStable();
    expect(second.hasAttribute('src')).toBe(false);
    const file = image()!;
    expect(file.getAttribute('src')).toContain('/api/media-preview/mjpeg');

    host.shown.set(false);
    await fixture.whenStable();
    expect(file.hasAttribute('src')).toBe(false);
  });

  it('a stream that failed after showing frames is unavailable without asking again: the cap only refuses a new one', async () => {
    await show(slot(1, { state: 'external' }));
    const live = image()!;
    decodeFirstFrame(live);
    vi.advanceTimersByTime(100);
    await fixture.whenStable();
    live.dispatchEvent(new Event('error'));
    await fixture.whenStable();
    http.expectNone((request) => request.url.startsWith('/stream/preview/'));
    expect(text()).toContain('Preview unavailable.');
    expect(text()).not.toContain('too many');
  });

  it('keeps the same live image when a poll brings an equal playing slot', async () => {
    const playing = () => slot(1, { file: 'cars.mp4', codec: 'h264', state: 'playing' });
    await show(playing());
    const live = image()!;
    const src = live.getAttribute('src');
    decodeFirstFrame(live);
    vi.advanceTimersByTime(100);
    await fixture.whenStable();
    expect(text()).not.toContain('Connecting');

    // The 2 s poll parses a new object for a slot that did not change.
    vi.setSystemTime(1_737_000_002_000);
    host.slot.set(playing());
    await fixture.whenStable();
    expect(image()).toBe(live);
    expect(live.getAttribute('src')).toBe(src);
    expect(src).toContain('t=1737000000000');
    expect(text()).not.toContain('Connecting');
  });

  it('stops looking for the first frame when the slot changes or the preview goes', async () => {
    await show(slot(1, { state: 'external' }));
    expect(vi.getTimerCount()).toBe(1);

    // Another slot: a new stream, a new token, and one watch for it alone.
    vi.setSystemTime(1_737_000_009_000);
    host.slot.set(slot(4, { state: 'external' }));
    await fixture.whenStable();
    expect(image()!.getAttribute('src')).toBe('/stream/preview/src4.mjpg?t=1737000009000');
    expect(vi.getTimerCount()).toBe(1);

    host.shown.set(false);
    await fixture.whenStable();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('previewFailure', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    // RxJS schedules its timeout with an interval.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    vi.useRealTimers();
  });

  it('gives up after 3 s on a request that does not answer, and ends it', () => {
    const outcomes: string[] = [];
    previewFailure(TestBed.inject(HttpClient), '/stream/preview/src1.mjpg?t=1').subscribe(
      (outcome) => outcomes.push(outcome),
    );
    const probe = http.expectOne('/stream/preview/src1.mjpg?t=1');
    vi.advanceTimersByTime(2999);
    expect(outcomes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(outcomes).toEqual(['failed']);
    expect(probe.cancelled).toBe(true);
  });

  it('reads a 429 from the headers as the cap on previews', () => {
    const outcomes: string[] = [];
    previewFailure(TestBed.inject(HttpClient), '/stream/preview/src1.mjpg?t=1').subscribe(
      (outcome) => outcomes.push(outcome),
    );
    const probe = http.expectOne('/stream/preview/src1.mjpg?t=1');
    probe.event(new HttpHeaderResponse({ status: 429, statusText: 'Too Many Requests' }));
    expect(outcomes).toEqual(['busy']);
    expect(probe.cancelled).toBe(true);
  });
});
