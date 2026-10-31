import { HttpClient, HttpHeaderResponse, provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import type { Slot, SlotPull } from '../../sources/api';
import {
  PREVIEW_RETRIES,
  PREVIEW_RETRY_MS,
  PREVIEW_STABLE_MS,
  previewFailure,
  SlotPreview,
} from './slot-preview';

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
    // RxJS schedules its timers (the retry's pause) with an interval, which this fakes.
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
  /** What the frame says where there is nothing to show (its badge is separate). */
  const message = () => root().querySelector('.message')?.textContent?.replace(/\s+/g, ' ').trim();
  const video = () => root().querySelector('video');
  const button = (label: string) =>
    [...root().querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!;

  /** What the browser does once the multipart stream's first frame is decoded. */
  function decodeFirstFrame(img: HTMLImageElement): void {
    Object.defineProperty(img, 'naturalWidth', { configurable: true, value: 1280 });
  }

  /** The live image fails before its first frame; the probe of the same URL is answered by `answer`. */
  async function failEarly(
    answer: (probe: TestRequest) => void = (probe) =>
      probe.flush({ error: 'Source is not live' }, { status: 409, statusText: 'Conflict' }),
  ): Promise<TestRequest> {
    image()!.dispatchEvent(new Event('error'));
    await fixture.whenStable();
    const probe = http.expectOne((request) => request.url.startsWith('/stream/preview/'));
    answer(probe);
    await fixture.whenStable();
    return probe;
  }

  /** Waits out the pause before an automatic retry, which then shows a new image. */
  async function waitForRetry(): Promise<void> {
    vi.advanceTimersByTime(PREVIEW_RETRY_MS);
    await fixture.whenStable();
  }

  /** Fails the image and lets the retry that follows it start, `times` over. */
  async function retriesThrough(times: number): Promise<string[]> {
    const srcs: string[] = [];
    for (let attempt = 0; attempt < times; attempt++) {
      await failEarly();
      expect(text(), `retry ${attempt + 1} is on its way`).not.toContain('Preview unavailable');
      await waitForRetry();
      srcs.push(image()!.getAttribute('src')!);
    }
    return srcs;
  }

  /** The last failure: nothing more is tried, and the user is offered Retry. */
  async function expectGivesUp(): Promise<void> {
    await failEarly();
    expect(text()).toContain('Preview unavailable.');
    expect(button('Retry')).toBeDefined();
    vi.advanceTimersByTime(10 * PREVIEW_RETRY_MS);
    await fixture.whenStable();
    expect(image()).toBeNull();
    http.expectNone((request) => request.url.startsWith('/stream/preview/'));
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

  it('a preview that fails before its first frame is retried by itself, a second apart, then reported unavailable with Retry', async () => {
    await show(slot(2, { state: 'pulled', pull: pull() }));
    const first = image()!.getAttribute('src');
    expect(first).toBe('/stream/preview/src2.mjpg?t=1737000000000&s=2026-10-24T08%3A00%3A00Z');

    // The stream was not ready yet: nothing is said, the pause is a second, and the new request
    // is a new image.
    await failEarly();
    expect(image()).toBeNull();
    expect(text()).not.toContain('Preview unavailable');
    vi.advanceTimersByTime(PREVIEW_RETRY_MS - 1);
    await fixture.whenStable();
    expect(image()).toBeNull();
    vi.advanceTimersByTime(1);
    await fixture.whenStable();
    expect(image()!.getAttribute('src')).not.toBe(first);

    // Then as many more as the limit allows, each a new request, and then it stops for good.
    const srcs = [first, image()!.getAttribute('src')!];
    srcs.push(...(await retriesThrough(PREVIEW_RETRIES - 1)));
    expect(new Set(srcs).size).toBe(PREVIEW_RETRIES + 1);
    await expectGivesUp();
    expect(text()).not.toContain('too many');
  });

  it('a failure the second request does not repeat is retried too, and its request is dropped', async () => {
    await show(slot(2, { state: 'external' }));
    // The stream answers this time: only its status was wanted, so the request ends there.
    const probe = await failEarly((request) =>
      request.event(new HttpHeaderResponse({ status: 200, statusText: 'OK' })),
    );
    expect(probe.cancelled).toBe(true);
    await waitForRetry();
    expect(image()).not.toBeNull();
    await retriesThrough(PREVIEW_RETRIES - 1);
    await expectGivesUp();
  });

  it('the server’s cap on previews is reported at once and never retried by itself', async () => {
    await show(slot(2, { state: 'external' }));
    await failEarly((probe) =>
      probe.flush({ error: 'Too many previews open' }, { status: 429, statusText: 'x' }),
    );
    expect(text()).toContain('Preview unavailable: too many previews open');
    vi.advanceTimersByTime(10 * PREVIEW_RETRY_MS);
    await fixture.whenStable();
    expect(image()).toBeNull();
    http.expectNone((request) => request.url.startsWith('/stream/preview/'));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a retry that meets the cap on previews stops there', async () => {
    await show(slot(2, { state: 'external' }));
    await failEarly();
    await waitForRetry();
    await failEarly((probe) =>
      probe.flush({ error: 'Too many previews open' }, { status: 429, statusText: 'x' }),
    );
    expect(text()).toContain('too many previews open');
    vi.advanceTimersByTime(10 * PREVIEW_RETRY_MS);
    await fixture.whenStable();
    expect(image()).toBeNull();
  });

  it('a frame shown starts the count again: the next stream of the slot gets all its retries', async () => {
    await show(slot(1, { state: 'pulled', pull: pull() }));
    await retriesThrough(PREVIEW_RETRIES - 1);
    decodeFirstFrame(image()!);
    vi.advanceTimersByTime(100);
    await fixture.whenStable();
    expect(text()).not.toContain('Connecting');

    // The publisher reconnects: a new session is a new stream, which fails before its first frame.
    host.slot.set(slot(1, { state: 'pulled', pull: pull({ since: '2026-10-24T09:00:00Z' }) }));
    await fixture.whenStable();
    await retriesThrough(PREVIEW_RETRIES);
    await expectGivesUp();
  });

  /** The image shows its first frame and stays up for `ms`. */
  async function showsFrameFor(ms: number): Promise<void> {
    decodeFirstFrame(image()!);
    vi.advanceTimersByTime(100);
    await fixture.whenStable();
    expect(text()).not.toContain('Connecting');
    vi.advanceTimersByTime(ms);
    await fixture.whenStable();
  }

  it('a stream that stayed up for a while before it dropped is retried, with a fresh budget', async () => {
    await show(slot(1, { state: 'external' }));
    await retriesThrough(PREVIEW_RETRIES - 1);
    // A camera swap on a live slot: the image showed frames for a good while, then the stream is
    // gone for a moment.
    const live = image()!;
    await showsFrameFor(PREVIEW_STABLE_MS);
    live.dispatchEvent(new Event('error'));
    await fixture.whenStable();
    const probe = http.expectOne((request) => request.url.startsWith('/stream/preview/'));
    probe.flush({ error: 'Source is not live' }, { status: 409, statusText: 'Conflict' });
    await fixture.whenStable();
    await waitForRetry();
    // It shows again; the drop took the first of a whole budget, so two more retries are left.
    expect(image()).not.toBe(live);
    expect(text()).not.toContain('Preview unavailable');
    await retriesThrough(PREVIEW_RETRIES - 1);
    await expectGivesUp();
  });

  it('a drop soon after a frame spends from the same budget, so a stream that flaps gives up', async () => {
    await show(slot(1, { state: 'external' }));
    // Each attempt shows a frame, 1 s of video, and drops: the frame does not give the retries back.
    for (let attempt = 0; attempt < PREVIEW_RETRIES; attempt++) {
      await showsFrameFor(1000);
      await failEarly();
      expect(text(), `retry ${attempt + 1} is on its way`).not.toContain('Preview unavailable');
      await waitForRetry();
    }
    await showsFrameFor(1000);
    await expectGivesUp();
  });

  it('a drop just short of the stable time still spends a retry, and the time counts from the frame', async () => {
    await show(slot(1, { state: 'external' }));
    await retriesThrough(PREVIEW_RETRIES - 1);
    await showsFrameFor(PREVIEW_STABLE_MS - 1);
    // One retry is left, and this drop uses it.
    await failEarly();
    await waitForRetry();
    await expectGivesUp();
  });

  it('a drop after frames that meets the cap on previews is reported at once', async () => {
    await show(slot(1, { state: 'external' }));
    const live = image()!;
    decodeFirstFrame(live);
    vi.advanceTimersByTime(100);
    await fixture.whenStable();
    await failEarly((probe) =>
      probe.flush({ error: 'Too many previews open' }, { status: 429, statusText: 'x' }),
    );
    expect(text()).toContain('too many previews open');
    vi.advanceTimersByTime(10 * PREVIEW_RETRY_MS);
    await fixture.whenStable();
    expect(image()).toBeNull();
  });

  it('a stream restarted after the retries were used up gets all of them again', async () => {
    const playing = () => slot(1, { file: 'cars.mp4', codec: 'h264', state: 'playing' });
    await show(playing());
    await retriesThrough(PREVIEW_RETRIES);
    await expectGivesUp();

    // Stopped, then started again: another stream, not a retry of the one that failed.
    host.slot.set(slot(1, { file: 'cars.mp4', codec: 'h264', state: 'stopped' }));
    await fixture.whenStable();
    host.slot.set(playing());
    await fixture.whenStable();
    expect(image()).not.toBeNull();
    await retriesThrough(PREVIEW_RETRIES);
    await expectGivesUp();
  });

  it('a stream stopped and started again is a new request that connects before it shows', async () => {
    const playing = () => slot(1, { file: 'cars.mp4', codec: 'h264', state: 'playing' });
    await show(playing());
    const first = image()!.getAttribute('src');
    await showsFrameFor(0);

    host.slot.set(slot(1, { file: 'cars.mp4', codec: 'h264', state: 'stopped' }));
    await fixture.whenStable();
    vi.setSystemTime(1_737_000_009_000);
    host.slot.set(playing());
    await fixture.whenStable();

    // Not the URL the browser may still hold a stale image for, and not shown as connected.
    const again = image()!;
    expect(again.getAttribute('src')).toBe('/stream/preview/src1.mjpg?t=1737000009000');
    expect(again.getAttribute('src')).not.toBe(first);
    expect(text()).toContain('Connecting to src1…');
    await showsFrameFor(0);
  });

  it('a publisher’s new session after the retries were used up gets all of them again', async () => {
    await show(slot(1, { state: 'pulled', pull: pull() }));
    await retriesThrough(PREVIEW_RETRIES);
    await expectGivesUp();

    // A camera swap on a live slot: the publisher connects again under a new session.
    host.slot.set(slot(1, { state: 'pulled', pull: pull({ since: '2026-10-24T09:00:00Z' }) }));
    await fixture.whenStable();
    await retriesThrough(PREVIEW_RETRIES);
    await expectGivesUp();
  });

  it('keeps saying Connecting through the check of a failure and the pause before the retry', async () => {
    await show(slot(1, { state: 'external' }));
    expect(text()).toContain('Connecting to src1…');
    const status = () => root().querySelector('[role="status"]')!;
    for (let attempt = 0; attempt < PREVIEW_RETRIES; attempt++) {
      image()!.dispatchEvent(new Event('error'));
      await fixture.whenStable();
      // The probe is out.
      expect(image()).toBeNull();
      expect(text()).toContain('Connecting to src1…');
      http
        .expectOne((request) => request.url.startsWith('/stream/preview/'))
        .flush(null, { status: 409, statusText: 'Conflict' });
      await fixture.whenStable();
      // The pause.
      expect(image()).toBeNull();
      expect(text()).toContain('Connecting to src1…');
      expect(root().querySelector('neat-progress')).not.toBeNull();
      const announced = status().firstElementChild;
      await waitForRetry();
      expect(text()).toContain('Connecting to src1…');
      // The same announcement element throughout: it is not said again for each attempt.
      expect(status().firstElementChild).toBe(announced);
    }
    // Reported at the end: nothing to wait for any more.
    await expectGivesUp();
    expect(text()).not.toContain('Connecting');
  });

  it('another slot and Retry each start the count again', async () => {
    await show(slot(1, { state: 'external' }));
    await retriesThrough(PREVIEW_RETRIES - 1);

    host.slot.set(slot(4, { state: 'external' }));
    await fixture.whenStable();
    await retriesThrough(PREVIEW_RETRIES);
    await expectGivesUp();

    button('Retry').click();
    await fixture.whenStable();
    await retriesThrough(PREVIEW_RETRIES);
    await expectGivesUp();
  });

  it('a retry waiting when the slot changes or the preview goes does nothing', async () => {
    await show(slot(1, { state: 'external' }));
    await failEarly();
    expect(vi.getTimerCount()).toBe(1);

    host.slot.set(slot(4, { state: 'external' }));
    await fixture.whenStable();
    const other = image()!;
    const src = other.getAttribute('src');
    vi.advanceTimersByTime(3 * PREVIEW_RETRY_MS);
    await fixture.whenStable();
    expect(image()).toBe(other);
    expect(other.getAttribute('src')).toBe(src);

    other.dispatchEvent(new Event('error'));
    await fixture.whenStable();
    http
      .expectOne((request) => request.url.startsWith('/stream/preview/src4.mjpg'))
      .flush(null, {
        status: 409,
        statusText: 'Conflict',
      });
    await fixture.whenStable();
    host.shown.set(false);
    await fixture.whenStable();
    expect(vi.getTimerCount()).toBe(0);
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
    expect(message()).toBe('Waiting for the camera… (connection refused)');

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
    expect(message()).toBe('The camera rejected the username or password');
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

  describe('badge', () => {
    const badge = () => root().querySelector<HTMLElement>('.badge');
    const badgeText = () => badge()?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
    /** A live badge has the kit's pulsing dot; any other has the grey one. */
    const liveDot = () => badge()?.querySelector('neat-live-dot .beat') ?? null;
    const greyDot = () => badge()?.querySelector('.idle') ?? null;

    function expectLive(): void {
      expect(badgeText()).toBe('Live');
      expect(liveDot()).not.toBeNull();
      expect(greyDot()).toBeNull();
    }

    function expectNotLive(label: string): void {
      expect(badgeText()).toBe(label);
      expect(liveDot()).toBeNull();
      expect(greyDot()).not.toBeNull();
    }

    it('says File preview with a grey dot for a stopped file slot, in place of a caption', async () => {
      await show(slot(1, { file: 'people/walk 1.mp4', codec: 'h264' }));
      expectNotLive('File preview');
      expect(root().querySelector('.caption')).toBeNull();
      expect(text().match(/File preview/g)).toHaveLength(1);
    });

    it('says Live when the file slot starts and File preview again when it stops', async () => {
      await show(slot(1, { file: 'cars.mp4', codec: 'h264' }));
      expectNotLive('File preview');

      host.slot.set(slot(1, { file: 'cars.mp4', codec: 'h264', state: 'playing' }));
      await fixture.whenStable();
      expectLive();

      host.slot.set(slot(1, { file: 'cars.mp4', codec: 'h264' }));
      await fixture.whenStable();
      expectNotLive('File preview');
    });

    it('says Live for a publisher that holds the slot', async () => {
      await show(slot(2, { state: 'external' }));
      expectLive();
    });

    it('says Live on a slot that is connecting, retrying or whose preview failed: the slot is live', async () => {
      await show(slot(1, { state: 'playing', file: 'cars.mp4', codec: 'h264' }));
      expect(text()).toContain('Connecting to src1…');
      expectLive();

      // A failed attempt waits to be tried again, still connecting.
      await failEarly();
      expect(text()).toContain('Connecting to src1…');
      expectLive();

      // Out of retries: the message and Retry, the slot still live.
      await waitForRetry();
      await retriesThrough(PREVIEW_RETRIES - 1);
      await expectGivesUp();
      expectLive();

      // The server's cap on previews says the same.
      host.slot.set(slot(2, { state: 'playing', file: 'cars.mp4', codec: 'h264' }));
      await fixture.whenStable();
      await failEarly((probe) =>
        probe.flush({ error: 'Too many previews' }, { status: 429, statusText: 'Too Many' }),
      );
      expect(text()).toContain('Preview unavailable: too many previews open');
      expectLive();
    });

    it('says Camera preview over the local camera and nothing once it is gone', async () => {
      const stream = {} as MediaStream;
      await show(slot(3, { type: 'webcam' }), stream);
      expect(video()).not.toBeNull();
      expectNotLive('Camera preview');

      host.stream.set(null);
      await fixture.whenStable();
      expect(text()).toBe('Start this source to preview the live webcam.');
      expect(badge()).toBeNull();
    });

    it('follows a webcam from camera preview to live, through a camera swap, and back', async () => {
      const stream = {} as MediaStream;
      await show(slot(3, { type: 'webcam' }), stream);
      expectNotLive('Camera preview');

      host.slot.set(slot(3, { type: 'webcam', state: 'playing' }));
      await fixture.whenStable();
      expectLive();

      // A camera swap of a live slot is a new publisher session; the slot never stops being live.
      host.slot.set(
        slot(3, {
          type: 'webcam',
          state: 'external',
          external: { since: '2026-10-26T09:00:00Z' } as Slot['external'],
        }),
      );
      await fixture.whenStable();
      expectLive();

      host.slot.set(slot(3, { type: 'webcam' }));
      await fixture.whenStable();
      expectNotLive('Camera preview');
    });

    it('has no badge where the frame shows nothing else', async () => {
      await show(slot(1));
      expect(text()).toBe('Assign a media file to preview.');
      expect(badge()).toBeNull();

      host.slot.set(slot(1, { type: 'webcam' }));
      await fixture.whenStable();
      expect(badge()).toBeNull();
    });

    it('says Not live over the waiting text of a pull that waits or fails, and Live when it pulls', async () => {
      await show(slot(2, { state: 'pulled', pull: pull({ status: 'connecting', since: null }) }));
      expectNotLive('Not live');
      expect(text()).toContain('Waiting for the camera…');

      host.slot.set(
        slot(2, {
          state: 'pulled',
          pull: pull({ status: 'unreachable', error: 'connection refused', since: null }),
        }),
      );
      await fixture.whenStable();
      expectNotLive('Not live');

      host.slot.set(
        slot(2, {
          state: 'pulled',
          pull: pull({ status: 'auth_failed', error: 'Wrong password' }),
        }),
      );
      await fixture.whenStable();
      expectNotLive('Not live');
      expect(text()).toContain('Wrong password');
    });

    it('follows a pull as it goes live and drops', async () => {
      await show(slot(2, { state: 'pulled', pull: pull({ status: 'connecting', since: null }) }));
      expectNotLive('Not live');
      expect(image()).toBeNull();

      host.slot.set(slot(2, { state: 'pulled', pull: pull() }));
      await fixture.whenStable();
      expectLive();
      expect(image()).not.toBeNull();

      host.slot.set(
        slot(2, { state: 'pulled', pull: pull({ status: 'unreachable', error: 'timeout' }) }),
      );
      await fixture.whenStable();
      expectNotLive('Not live');
      expect(image()).toBeNull();

      host.slot.set(slot(2, { state: 'pulled', pull: pull({ since: '2026-10-26T09:00:00Z' }) }));
      await fixture.whenStable();
      expectLive();
    });

    it('is a dark pill over a picture and a muted one over an empty frame', async () => {
      const onPicture = () => badge()!.classList.contains('on-picture');

      await show(slot(1, { file: 'cars.mp4', codec: 'h264' }));
      expect(onPicture()).toBe(true);

      // A live slot has no picture until its first frame.
      host.slot.set(slot(1, { state: 'playing', file: 'cars.mp4', codec: 'h264' }));
      await fixture.whenStable();
      expect(onPicture()).toBe(false);
      decodeFirstFrame(image()!);
      vi.advanceTimersByTime(100);
      await fixture.whenStable();
      expect(onPicture()).toBe(true);

      host.slot.set(
        slot(2, { state: 'pulled', pull: pull({ status: 'unreachable', since: null }) }),
      );
      await fixture.whenStable();
      expect(onPicture()).toBe(false);

      host.slot.set(slot(3, { type: 'webcam' }));
      host.stream.set({} as MediaStream);
      await fixture.whenStable();
      expect(onPicture()).toBe(true);
    });

    it('is part of the frame’s accessible description, which a changed badge keeps up with', async () => {
      await show(slot(1, { file: 'cars.mp4', codec: 'h264' }));
      const frame = root().querySelector('app-preview-frame')!;
      const described = () => {
        const id = frame.getAttribute('aria-describedby');
        return id === null ? null : root().querySelector(`#${id}`)?.textContent?.trim();
      };
      expect(frame.getAttribute('role')).toBe('group');
      expect(frame.getAttribute('aria-label')).toBe('Preview of src1');
      expect(described()).toBe('File preview');

      host.slot.set(slot(1, { state: 'playing', file: 'cars.mp4', codec: 'h264' }));
      await fixture.whenStable();
      expect(described()).toBe('Live');

      host.slot.set(slot(1));
      await fixture.whenStable();
      expect(frame.hasAttribute('aria-describedby')).toBe(false);
    });

    it('is read once: the frame’s description carries it and the badge itself is hidden from readers', async () => {
      await show(slot(1, { state: 'playing', file: 'cars.mp4', codec: 'h264' }));
      const frame = root().querySelector('app-preview-frame')!;
      // A description reads from the element it names even when that is hidden, so hiding the badge
      // takes it out of the frame's content without shortening the description.
      expect(badge()!.getAttribute('aria-hidden')).toBe('true');
      expect(badge()!.id).toBe(frame.getAttribute('aria-describedby'));
      expect(badgeText()).toBe('Live');
    });
  });

  // The slot kinds a publisher or the server's pull holds, which show no file and no local camera:
  // only their stream, or the words for why there is none.
  describe('a slot that is held by a publisher or pulled', () => {
    const badge = () => root().querySelector<HTMLElement>('.badge');
    const badgeText = () => badge()?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
    const description = () => {
      const id = root().querySelector('app-preview-frame')!.getAttribute('aria-describedby');
      return id === null ? null : root().querySelector(`#${id}`)?.textContent?.trim();
    };
    const state = () => ({
      badge: badgeText(),
      description: description(),
      onPicture: badge()?.classList.contains('on-picture') ?? null,
      image: image()?.getAttribute('src') ?? null,
      video: video() !== null,
      message: message() ?? null,
    });

    async function showFirstFrame(): Promise<void> {
      decodeFirstFrame(image()!);
      vi.advanceTimersByTime(100);
      await fixture.whenStable();
    }

    it('an external slot shows its stream, Live, and never its file or the local camera', async () => {
      const since = '2026-10-26T09:00:00Z';
      await show(
        slot(2, {
          state: 'external',
          type: 'webcam',
          file: 'cars.mp4',
          codec: 'h264',
          external: { since } as Slot['external'],
        }),
        {} as MediaStream,
      );
      // Connecting: the slot is live, there is no picture yet to put the badge on.
      expect(state()).toEqual({
        badge: 'Live',
        description: 'Live',
        onPicture: false,
        image: `/stream/preview/src2.mjpg?t=1737000000000&s=${encodeURIComponent(since)}`,
        video: false,
        message: null,
      });
      expect(text()).toContain('Connecting to src2…');
      expect(text()).not.toContain('File preview');

      await showFirstFrame();
      expect(text()).not.toContain('Connecting');
      expect(state().onPicture).toBe(true);
      expect(state().description).toBe('Live');
    });

    it('an external slot whose preview failed is still Live, with the message and Retry', async () => {
      await show(slot(2, { state: 'external', external: { since: 'a' } as Slot['external'] }));
      await failEarly((probe) =>
        probe.flush({ error: 'Too many previews' }, { status: 429, statusText: 'Too Many' }),
      );
      expect(state()).toMatchObject({
        badge: 'Live',
        description: 'Live',
        onPicture: false,
        image: null,
        message: 'Preview unavailable: too many previews open Retry',
      });
    });

    it('a pull that has not connected is Not live, with the wait said and no file shown', async () => {
      await show(
        slot(3, {
          state: 'pulled',
          file: 'cars.mp4',
          codec: 'h264',
          pull: pull({ status: 'connecting', since: null }),
        }),
      );
      expect(state()).toEqual({
        badge: 'Not live',
        description: 'Not live',
        onPicture: false,
        image: null,
        video: false,
        message: 'Waiting for the camera…',
      });
      expect(text()).not.toContain('File preview');
    });

    it('a pull that cannot be reached says why, in the wait, and an unexplained one just waits', async () => {
      await show(
        slot(3, {
          state: 'pulled',
          pull: pull({ status: 'unreachable', error: 'connection refused', since: null }),
        }),
      );
      expect(state()).toMatchObject({
        badge: 'Not live',
        description: 'Not live',
        message: 'Waiting for the camera… (connection refused)',
      });

      host.slot.set(
        slot(3, { state: 'pulled', pull: pull({ status: 'unreachable', since: null }) }),
      );
      await fixture.whenStable();
      expect(state()).toMatchObject({
        badge: 'Not live',
        message: 'Waiting for the camera…',
      });
    });

    it('a pull the camera refused shows the camera’s words, or none, and stays Not live', async () => {
      await show(
        slot(3, {
          state: 'pulled',
          pull: pull({ status: 'auth_failed', error: 'Wrong password' }),
        }),
      );
      expect(state()).toMatchObject({
        badge: 'Not live',
        description: 'Not live',
        image: null,
        message: 'Wrong password',
      });

      host.slot.set(
        slot(3, { state: 'pulled', pull: pull({ status: 'auth_failed', error: null }) }),
      );
      await fixture.whenStable();
      expect(state()).toMatchObject({ badge: 'Not live', image: null, message: null });
    });

    it('a pull that is live shows its stream as Live, a new session of it as a new image', async () => {
      await show(slot(3, { state: 'pulled', pull: pull({ since: '2026-10-26T09:00:00Z' }) }));
      expect(state()).toMatchObject({
        badge: 'Live',
        description: 'Live',
        onPicture: false,
        image: `/stream/preview/src3.mjpg?t=1737000000000&s=${encodeURIComponent('2026-10-26T09:00:00Z')}`,
        message: null,
      });
      await showFirstFrame();
      expect(state().onPicture).toBe(true);

      vi.setSystemTime(1_737_000_100_000);
      host.slot.set(slot(3, { state: 'pulled', pull: pull({ since: '2026-10-26T10:00:00Z' }) }));
      await fixture.whenStable();
      expect(state().image).toContain('s=2026-10-26T10%3A00%3A00Z');
      expect(state().onPicture).toBe(false);
    });
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
