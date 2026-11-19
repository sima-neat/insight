import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import {
  afterEveryRender,
  ApplicationRef,
  Component,
  createEnvironmentInjector,
  EnvironmentInjector,
  inject,
  Injector,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NeatLevelMeter } from '@sima/neat-ui/level-meter';
import { boardUrl } from '../board/api';
import { DEVKIT, MANUAL } from '../board/board.testing';
import type { MicrophoneItem, MicTestStatus } from './api';
import { MicTest } from './mic-test';
import {
  MIC_TEST_IDLE,
  MIC_TEST_MAX_FAILURES,
  MIC_TEST_POLL_MS,
  micTestAction,
  micTestErrorAction,
} from './mic-test-state';
import { micTestStatus, onboardMic, readyTest, testAudioUrl, yeti } from './microphones.testing';

const BOARD = DEVKIT.id;
const TEST_URL = boardUrl(BOARD, 'microphones/test');
const startUrl = (mic: MicrophoneItem = yeti) =>
  boardUrl(BOARD, `microphones/${encodeURIComponent(mic.id)}/test`);
/** The stop of test `id` of the Yeti, which names the test. */
const stopUrl = (id: string) => `${startUrl()}/stop?test=${id}`;
const isStop = (request: { url: string }) => request.url.endsWith('/test/stop');
/** The error shape the server answers with. */
const failure = (code: string, message: string, hint?: string) => ({
  error: { code, message, ...(hint ? { hint } : {}) },
});
const IN_USE_HINT =
  'Stop the application that is recording from it, then test again. Insight never stops it for you.';

describe('MicTest', () => {
  let http: HttpTestingController;
  let parent: EnvironmentInjector;
  /** The injectors standing in for a visit to the page, each destroyed at most once. */
  let visits: Set<EnvironmentInjector>;
  let micTest: MicTest;
  let audio: HTMLAudioElement;
  let play: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let pause: ReturnType<typeof vi.fn<() => void>>;

  /** A visit to the Peripherals page: a `MicTest` provided for it, as the page provides one. */
  function visit(): { micTest: MicTest; injector: EnvironmentInjector } {
    const injector = createEnvironmentInjector([MicTest], parent);
    visits.add(injector);
    return { micTest: injector.get(MicTest), injector };
  }

  /** The page goes: its injector is destroyed. */
  function leave(injector: EnvironmentInjector): void {
    visits.delete(injector);
    injector.destroy();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    parent = TestBed.inject(EnvironmentInjector);
    visits = new Set();
    micTest = visit().micTest;
    // jsdom does not play media: the element's playing is the test's to stub.
    audio = document.createElement('audio');
    play = vi.fn(async () => undefined);
    pause = vi.fn();
    audio.play = play;
    audio.pause = pause;
    micTest.attachAudio(audio);
  });

  afterEach(() => {
    for (const injector of visits) injector.destroy();
    http.verify();
    vi.useRealTimers();
  });

  /** Lets the promise chains behind a flushed request run. */
  const settle = () => vi.advanceTimersByTimeAsync(0);

  /** Answers the status read sent now (a poll, a resume or a lookup) with the board's test. */
  async function answerRead(test: MicTestStatus | null, url = TEST_URL): Promise<void> {
    http.expectOne({ method: 'GET', url }).flush({ test });
    await settle();
  }

  /** Fails the status read sent now, as when the network blips. */
  async function failRead(): Promise<void> {
    http
      .expectOne({ method: 'GET', url: TEST_URL })
      .flush(failure('unavailable', 'Insight is restarting.'), {
        status: 503,
        statusText: 'Service Unavailable',
      });
    await settle();
  }

  /** Answers the start sent last (202), after checking it names the microphone and nothing else. */
  async function answerStart(test: MicTestStatus, mic: MicrophoneItem = yeti): Promise<void> {
    const request = http.expectOne({ method: 'POST', url: startUrl(mic) });
    // `seconds` is left to the server's default of 30.
    expect(request.request.body).toEqual({});
    request.flush({ test }, { status: 202, statusText: 'Accepted' });
    await settle();
  }

  /** Expects the stop of test `id`. */
  const expectStop = (id: string) =>
    http.expectOne((request) => request.method === 'POST' && request.urlWithParams === stopUrl(id));

  /** Lets the next poll go out. */
  const nextPoll = () => vi.advanceTimersByTimeAsync(MIC_TEST_POLL_MS);

  /** The Yeti recording on the DevKit, started here, with its first level read. */
  async function startRecording(): Promise<void> {
    void micTest.start(yeti, BOARD);
    await answerStart(micTestStatus());
    await nextPoll();
    await answerRead(micTestStatus({ elapsed_ms: 300, level_dbfs: -30 }));
  }

  const status = () => micTest.state().status;

  // A test is keyed by its board, its microphone's id and its record.

  it('a microphone test belongs to one board: another board with the same microphone id starts afresh', async () => {
    void micTest.resume(yeti, BOARD);
    await answerRead(readyTest());
    expect(micTest.state()).toMatchObject({ status: 'done', micId: yeti.id });

    void micTest.resume(yeti, BOARD);
    http.expectNone(TEST_URL);
    expect(status()).toBe('done');

    // The other board's test is read from that board.
    void micTest.resume(yeti, MANUAL.id);
    expect(micTest.state()).toEqual({ ...MIC_TEST_IDLE, micId: yeti.id });
    await answerRead(null, boardUrl(MANUAL.id, 'microphones/test'));
    expect(status()).toBe('idle');
  });

  it('a rescan that lists another device under the same microphone id starts the test afresh', async () => {
    void micTest.resume(yeti, BOARD);
    await answerRead(readyTest());

    void micTest.resume({ ...yeti, device: { ...yeti.device } }, BOARD);
    http.expectNone(TEST_URL);
    expect(status()).toBe('done');

    void micTest.resume(
      { ...yeti, record: '77aa77aa77aa77aa', device: { ...yeti.device, card_index: 3 } },
      BOARD,
    );
    expect(status()).toBe('idle');
    await answerRead(null);
  });

  it('a rescan that changes only fields the page does not show still starts the test afresh', async () => {
    void micTest.resume(yeti, BOARD);
    await answerRead(readyTest());

    void micTest.resume({ ...yeti, record: 'b2b2b2b2b2b2b2b2' }, BOARD);
    expect(status()).toBe('idle');
    await answerRead(null);
  });

  it('polls every 100 ms while recording and exposes the latest level; 50 failed reads end the test', async () => {
    void micTest.start(yeti, BOARD);
    expect(micTest.state()).toEqual({
      status: 'recording',
      test: null,
      error: null,
      micId: yeti.id,
    });
    await answerStart(micTestStatus());
    // Read 100 ms after each status, the start's answer included.
    await vi.advanceTimersByTimeAsync(MIC_TEST_POLL_MS - 1);
    http.expectNone(TEST_URL);
    await vi.advanceTimersByTimeAsync(1);
    await answerRead(micTestStatus({ elapsed_ms: 1500, level_dbfs: -20 }));
    expect(micTest.level()).toBe(-20);
    expect(micTest.elapsed()).toBe(1);
    // The meter calls it on its own, unbound.
    const sample = micTest.level;
    expect(sample()).toBe(-20);

    await vi.advanceTimersByTimeAsync(MIC_TEST_POLL_MS - 1);
    http.expectNone(TEST_URL);
    await vi.advanceTimersByTimeAsync(1);
    await answerRead(micTestStatus({ elapsed_ms: 1600, level_dbfs: -12 }));
    expect(micTest.level()).toBe(-12);
    expect(micTest.elapsed()).toBe(1);

    // The read never contacts the board: a failure is retried, 100 ms apart, up to 50 times.
    await nextPoll();
    for (let failures = 1; failures < MIC_TEST_MAX_FAILURES; failures++) {
      await failRead();
      expect(status()).toBe('recording');
      await vi.advanceTimersByTimeAsync(MIC_TEST_POLL_MS);
    }
    await failRead();
    expect(MIC_TEST_MAX_FAILURES).toBe(50);
    expect(status()).toBe('error');
    expect(micTest.state().error).toMatchObject({
      code: 'unavailable',
      message: 'Insight is restarting.',
    });
    expect(micTest.level()).toBeNull();
    // The button records again.
    expect(micTestAction(status(), micTest.stopping()).label).toBe('Test microphone');
    await vi.advanceTimersByTimeAsync(MIC_TEST_POLL_MS * 10);
    http.expectNone(TEST_URL);
  });

  it('a failed stop keeps Stop available and takes up the recording when it arrives', async () => {
    await startRecording();
    const stopping = micTest.stop();
    expect(micTest.stopping()).toBe(true);
    expect(micTestAction(status(), micTest.stopping())).toEqual({
      label: 'Stopping…',
      action: 'stop',
      disabled: true,
    });
    expectStop('t1').error(new ProgressEvent('error'));
    await stopping;

    // The board may still be recording: Stop can be retried, and the failure is said.
    expect(micTest.state()).toMatchObject({ status: 'recording', error: { code: 'network' } });
    expect(micTest.stopping()).toBe(false);
    expect(micTestAction(status(), micTest.stopping())).toEqual({
      label: 'Stop recording',
      action: 'stop',
      disabled: false,
    });

    // The recording goes on being read, and its result is taken up when it arrives.
    await nextPoll();
    await answerRead(readyTest());
    expect(micTest.state()).toMatchObject({ status: 'playing', error: null });
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('Stop names the test it stops by its id', async () => {
    // A Stop for the board alone would end a test another tab had just started.
    await startRecording();
    const stopped = micTest.stop();
    expectStop('t1').flush({ test: micTestStatus() });
    await stopped;
    // Stopping until the poll picks the result up.
    expect(micTest.stopping()).toBe(true);
    await nextPoll();
    await answerRead(readyTest());
    expect(status()).toBe('playing');
    expect(micTest.stopping()).toBe(false);
  });

  it('a Stop pressed before the start answered is sent once the test has its id', async () => {
    // A finished recording is shown: its id is not the one to stop.
    void micTest.resume(yeti, BOARD);
    await answerRead(readyTest({ id: 't1' }));
    void micTest.start(yeti, BOARD);
    void micTest.stop();
    expect(micTest.stopping()).toBe(true);
    http.expectNone(isStop);

    await answerStart(micTestStatus({ id: 't9' }));
    expectStop('t9').flush({ test: micTestStatus({ id: 't9' }) });
    await nextPoll();
    await answerRead(readyTest({ id: 't9' }));
    expect(status()).toBe('playing');
    audio.dispatchEvent(new Event('ended'));

    // Stop pressed while a start whose answer is then lost: the recording it began is taken up
    // and stopped, and reads "Stopping…" until that stop answers.
    void micTest.start(yeti, BOARD);
    void micTest.stop();
    http.expectOne({ method: 'POST', url: startUrl() }).error(new ProgressEvent('error'));
    await settle();
    await answerRead(micTestStatus({ id: 't10' }));
    const takenUp = expectStop('t10');
    expect(micTest.stopping()).toBe(true);
    expect(micTestAction(status(), micTest.stopping())).toEqual({
      label: 'Stopping…',
      action: 'stop',
      disabled: true,
    });
    // Pressed again meanwhile, it sends no second stop.
    void micTest.stop();
    http.expectNone(isStop);
    takenUp.error(new ProgressEvent('error'));
    await settle();
    expect(micTest.stopping()).toBe(false);
    expect(micTest.state()).toMatchObject({ status: 'recording', error: { code: 'network' } });
    await nextPoll();
    await answerRead(readyTest({ id: 't10' }));
    expect(status()).toBe('playing');
  });

  it('resume takes up a recording or a ready test for this microphone only', async () => {
    // Opened mid-recording: the recording is taken up, with its level and clock, and read on.
    void micTest.resume(yeti, BOARD);
    await answerRead(micTestStatus({ elapsed_ms: 12_400, level_dbfs: -18 }));
    expect(micTest.state()).toMatchObject({ status: 'recording', micId: yeti.id });
    expect(micTest.level()).toBe(-18);
    expect(micTest.elapsed()).toBe(12);
    await nextPoll();
    await answerRead(micTestStatus({ elapsed_ms: 12_500, level_dbfs: -16 }));
    expect(micTest.level()).toBe(-16);

    // Another microphone's panel: the Yeti's recording goes on on the board, but is not shown.
    void micTest.resume(onboardMic, BOARD);
    expect(micTest.state()).toEqual({ ...MIC_TEST_IDLE, micId: onboardMic.id });
    expect(micTest.level()).toBeNull();
    await answerRead(micTestStatus({ elapsed_ms: 12_600, level_dbfs: -16 }));
    expect(status()).toBe('idle');
    // Nothing reads the Yeti's test any more.
    await vi.advanceTimersByTimeAsync(MIC_TEST_POLL_MS * 5);
    http.expectNone(TEST_URL);

    // Back on the Yeti, its finished recording is offered for Replay, not played by itself.
    void micTest.resume(yeti, BOARD);
    await answerRead(readyTest());
    expect(micTest.state()).toMatchObject({ status: 'done', micId: yeti.id, test: readyTest() });
    expect(play).not.toHaveBeenCalled();

    // A failed test is not taken up.
    void micTest.resume(onboardMic, BOARD);
    await answerRead(micTestStatus({ microphone: onboardMic.id, state: 'failed' }));
    expect(status()).toBe('idle');

    // A failed read is retried; one that says the test is gone leaves the panel idle.
    void micTest.resume(yeti, BOARD);
    await failRead();
    await nextPoll();
    await answerRead(micTestStatus({ elapsed_ms: 20_000 }));
    expect(status()).toBe('recording');
    void micTest.resume(onboardMic, BOARD);
    http.expectOne(TEST_URL).flush(failure('not_found', `${BOARD} is not the selected board.`), {
      status: 404,
      statusText: 'Not Found',
    });
    await settle();
    expect(micTest.state()).toEqual({ ...MIC_TEST_IDLE, micId: onboardMic.id });
  });

  it('a resume that answers after Test was pressed does not replace the test started here', async () => {
    void micTest.resume(yeti, BOARD);
    void micTest.start(yeti, BOARD);
    await answerRead(readyTest({ id: 'old' }));
    expect(micTest.state()).toMatchObject({ status: 'recording', test: null });
    await answerStart(micTestStatus());
    await nextPoll();
    await answerRead(micTestStatus({ level_dbfs: -25 }));
    expect(micTest.level()).toBe(-25);
  });

  it('a finished recording plays from 0 by itself, is done when it ends, and Replay plays it again', async () => {
    await startRecording();
    await nextPoll();
    await answerRead(readyTest());
    expect(micTest.state()).toMatchObject({ status: 'playing', test: readyTest() });
    expect(audio.src).toBe(new URL(testAudioUrl('t1'), document.baseURI).href);
    expect(play).toHaveBeenCalledTimes(1);
    // While it plays, the meter follows the playback level, not the recording's.
    expect(micTest.level()).toBeNull();
    // Nothing is read once the recording is in.
    await vi.advanceTimersByTimeAsync(MIC_TEST_POLL_MS * 5);
    http.expectNone(TEST_URL);

    audio.dispatchEvent(new Event('ended'));
    expect(status()).toBe('done');

    audio.currentTime = 4.2;
    micTest.replay();
    expect(status()).toBe('playing');
    expect(audio.currentTime).toBe(0);
    expect(audio.src).toBe(new URL(testAudioUrl('t1'), document.baseURI).href);
    expect(play).toHaveBeenCalledTimes(2);

    // Stop playing.
    await micTest.stop();
    expect(pause).toHaveBeenCalled();
    expect(status()).toBe('done');
    http.expectNone(isStop);

    // A seek the browser refuses does not fail the Replay.
    Object.defineProperty(audio, 'currentTime', {
      configurable: true,
      get: () => 4.2,
      set: () => {
        throw new DOMException('Not loaded yet', 'InvalidStateError');
      },
    });
    expect(() => micTest.replay()).not.toThrow();
    expect(status()).toBe('playing');
    expect(play).toHaveBeenCalledTimes(3);
    await micTest.stop();
    expect(status()).toBe('done');

    // A play the browser refuses (autoplay rules) ends the playback; Replay stays offered.
    play.mockRejectedValueOnce(new DOMException('Not allowed', 'NotAllowedError'));
    micTest.replay();
    await settle();
    expect(status()).toBe('done');
  });

  it('a playback whose element goes with the panel ends, and one with no element is not left playing', async () => {
    await startRecording();
    await nextPoll();
    await answerRead(readyTest());
    expect(status()).toBe('playing');
    micTest.attachAudio(null);
    expect(pause).toHaveBeenCalled();
    expect(status()).toBe('done');
    // Replay with no element to play in is not left playing.
    micTest.replay();
    expect(status()).toBe('done');

    // A recording that finished while no panel showed it is offered for Replay.
    void micTest.start(yeti, BOARD);
    await answerStart(micTestStatus({ id: 't2' }));
    await nextPoll();
    await answerRead(readyTest({ id: 't2' }));
    expect(status()).toBe('done');
  });

  it("a start that may have run adopts the board's test; one the board refused shows its error", async () => {
    // The answer was lost: the board's recording for this microphone is the one it began.
    void micTest.start(yeti, BOARD);
    http.expectOne({ method: 'POST', url: startUrl() }).error(new ProgressEvent('error'));
    await settle();
    await answerRead(micTestStatus({ id: 'new', elapsed_ms: 400, level_dbfs: -30 }));
    expect(micTest.state()).toMatchObject({ status: 'recording', error: null });
    expect(micTest.level()).toBe(-30);
    await nextPoll();
    await answerRead(readyTest({ id: 'new' }));
    expect(status()).toBe('playing');
    audio.dispatchEvent(new Event('ended'));

    // A microphone in use: the server answered, so its error stands, with the panel's hint.
    void micTest.start(yeti, BOARD);
    http
      .expectOne({ method: 'POST', url: startUrl() })
      .flush(failure('microphone_in_use', 'Open in arecord (pid 812).', IN_USE_HINT), {
        status: 409,
        statusText: 'Conflict',
      });
    await settle();
    http.expectNone(TEST_URL);
    const { error } = micTest.state();
    expect(micTest.state()).toMatchObject({ status: 'error', test: null });
    expect(error).toMatchObject({
      code: 'microphone_in_use',
      message: 'Open in arecord (pid 812).',
    });
    expect(micTestErrorAction(error)).toMatch(/Insight never stops it for you/);
    expect(micTestAction(status(), micTest.stopping()).label).toBe('Test microphone');

    // Refused because the board records already, for another microphone: the refusal stands.
    void micTest.start(onboardMic, BOARD);
    http
      .expectOne({ method: 'POST', url: startUrl(onboardMic) })
      .flush(
        failure(
          'test_running',
          'A microphone test is already recording.',
          'Wait for it to finish.',
        ),
        { status: 409, statusText: 'Conflict' },
      );
    await settle();
    await answerRead(micTestStatus({ id: 'yeti' }));
    expect(micTest.state()).toMatchObject({
      status: 'error',
      micId: onboardMic.id,
      error: { code: 'test_running', hint: 'Wait for it to finish.' },
    });
  });

  it('a test that ends early or fails on the board says so, and offers the test again', async () => {
    // Gone from the board (an Insight restart, a newer test from another tab).
    await startRecording();
    await nextPoll();
    await answerRead(null);
    expect(micTest.state().error).toMatchObject({
      message: 'The test ended before it finished.',
      hint: 'Test again.',
    });
    expect(micTestAction(status(), micTest.stopping()).action).toBe('record');

    await startRecording();
    await nextPoll();
    await answerRead(micTestStatus({ id: 'another' }));
    expect(micTest.state().error?.message).toBe('The test ended before it finished.');

    // Stopped before anything was recorded: the board's failure, with its hint.
    await startRecording();
    await nextPoll();
    await answerRead(
      micTestStatus({
        state: 'failed',
        error: {
          message: 'The test was stopped before anything was recorded.',
          code: 'stopped_early',
          hint: 'Test again and speak.',
        },
      }),
    );
    expect(micTest.state()).toMatchObject({
      status: 'error',
      error: {
        code: 'stopped_early',
        message: 'The test was stopped before anything was recorded.',
        hint: 'Test again and speak.',
      },
    });
    expect(micTestErrorAction(micTest.state().error)).toBe('Test again and speak.');

    // A status error that means the test is gone ends it at once, with no retries.
    await startRecording();
    await nextPoll();
    http
      .expectOne(TEST_URL)
      .flush(failure('board_changed', 'The board was replaced while this request was running.'), {
        status: 409,
        statusText: 'Conflict',
      });
    await settle();
    expect(micTest.state()).toMatchObject({ status: 'error', error: { code: 'board_changed' } });
    expect(micTestErrorAction(micTest.state().error)).toBe('Refresh, then test again.');
  });

  it('a silent recording plays and is done with its level, for the panel to warn about', async () => {
    await startRecording();
    await nextPoll();
    const silent = readyTest({ level: { peak_dbfs: null, rms_dbfs: null, silent: true } });
    await answerRead(silent);
    audio.dispatchEvent(new Event('ended'));
    expect(micTest.state()).toMatchObject({ status: 'done', test: { level: { silent: true } } });
  });

  it('leaving the page mid-recording stops reading; the next visit takes the recording up', async () => {
    await startRecording();
    const first = [...visits][0];
    leave(first);
    await vi.advanceTimersByTimeAsync(MIC_TEST_POLL_MS * 10);
    http.expectNone(TEST_URL);
    http.expectNone(isStop); // the board's recording is not stopped

    const next = visit().micTest;
    void next.resume(yeti, BOARD);
    await answerRead(micTestStatus({ elapsed_ms: 9_000, level_dbfs: -21 }));
    expect(next.state()).toMatchObject({ status: 'recording', micId: yeti.id });
    expect(next.elapsed()).toBe(9);
    expect(next.level()).toBe(-21);
    await nextPoll();
    await answerRead(readyTest());
    // No panel gave this visit an element yet: the recording waits for Replay.
    expect(next.state().status).toBe('done');
  });
});

/** requestAnimationFrame under the test's control: a frame runs only when the test says so. */
class FakeAnimationFrames {
  private readonly callbacks = new Map<number, FrameRequestCallback>();
  private nextId = 1;

  install(): void {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = this.nextId++;
      this.callbacks.set(id, callback);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => this.callbacks.delete(id));
  }

  run(): void {
    const pending = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of pending) callback(0);
  }
}

/** The microphone panel's meter as the panel binds it, on a page that provides the test. */
@Component({
  imports: [NeatLevelMeter],
  providers: [MicTest],
  template: `<neat-level-meter [sample]="micTest.level" />`,
})
class MeterHost {
  readonly micTest = inject(MicTest);
}

describe('MicTest with the kit level meter', () => {
  let frames: FakeAnimationFrames;

  beforeEach(() => {
    frames = new FakeAnimationFrames();
    frames.install();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('the meter samples the recording level every frame without a change detection', async () => {
    // Fake timeouts keep the test's own 100 ms poll from going out mid-count; Angular's scheduler
    // races a timeout against a frame, so a pass it schedules runs on `drain` or `frames.run`.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const drain = async () => {
      await vi.advanceTimersByTimeAsync(0);
      frames.run();
      await vi.advanceTimersByTimeAsync(0);
    };
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(MeterHost);
    const { micTest } = fixture.componentInstance;
    void micTest.resume(yeti, BOARD);
    http.expectOne(TEST_URL).flush({ test: micTestStatus({ level_dbfs: -5 }) });
    await drain();

    const element: HTMLElement = fixture.nativeElement;
    const segments = [...element.querySelectorAll('[data-slot="level-meter-segment"]')];
    const lit = () => segments.filter((segment) => !segment.classList.contains('bg-border')).length;
    const tick = vi.spyOn(TestBed.inject(ApplicationRef), 'tick');
    let renders = 0;
    afterEveryRender(() => renders++, { injector: fixture.componentRef.injector.get(Injector) });
    // Registering a hook schedules a pass of its own; let it run before counting.
    await drain();
    renders = 0;

    expect(lit()).toBe(25); // -5 dBFS lights 25 of 28

    // Inside the counted window the level changes, so only sampling during it can light the
    // meter as asserted below. The next poll's answer keeps the clock (still 0 s), so it writes
    // no signal the page reads.
    await vi.advanceTimersByTimeAsync(MIC_TEST_POLL_MS);
    http.expectOne(TEST_URL).flush({ test: micTestStatus({ level_dbfs: -25 }) });
    await vi.advanceTimersByTimeAsync(0);
    for (let frame = 0; frame < 5; frame++) frames.run();
    // A change detection scheduled by a frame would run on a later timeout or frame.
    await drain();

    // The positive control: the unbound `micTest.level` was sampled (-25 dBFS lights 14 of 28).
    expect(lit()).toBe(14);
    expect(tick).not.toHaveBeenCalled();
    expect(renders).toBe(0);

    // Leaving the page ends the test's reading.
    fixture.destroy();
    await vi.advanceTimersByTimeAsync(MIC_TEST_POLL_MS * 5);
    http.verify();
  });
});
