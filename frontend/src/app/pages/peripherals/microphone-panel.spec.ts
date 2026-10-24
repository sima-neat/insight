import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, computed, inject, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { NeatLevelMeter } from '@sima/neat-ui/level-meter';
import { NeatStatusChip } from '@sima/neat-ui/status-chip';
import { BoardService } from '../../board/board.service';
import { boardState, DEVKIT, FakeBoard } from '../../board/board.testing';
import type { MicrophoneItem, MicTestStatus } from '../../peripherals/api';
import { usb } from '../../peripherals/cameras.testing';
import { deviceRow } from '../../peripherals/devices';
import { MicTest } from '../../peripherals/mic-test';
import { MIC_TEST_POLL_MS } from '../../peripherals/mic-test-state';
import {
  micTestStatus,
  onboardMic,
  readyTest,
  yeti,
} from '../../peripherals/microphones.testing';
import { MicrophonePanel } from './microphone-panel';

const TEST_URL = '/api/peripherals/microphones/test';
const STOP_URL = '/api/peripherals/microphones/test/stop';
const IN_USE_HINT =
  'Stop the application that is recording from it, then test again. Insight never stops it for you.';

/** The webcam's microphone: the same USB device as the C270 camera. */
const webcamMic: MicrophoneItem = {
  ...yeti,
  device: { ...yeti.device, part_of: { id: usb.id, name: usb.name } },
};

/** An `AudioNode` that records what it is connected to. */
class FakeNode {
  readonly connected: unknown[] = [];
  connect(destination: unknown): void {
    this.connected.push(destination);
  }
}

class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  /** What the analyser hears now, the same over its whole window. */
  level = 0;
  getFloatTimeDomainData(target: Float32Array): void {
    target.fill(this.level);
  }
}

/** Web Audio's `AudioContext` as far as the playback level uses it, under the test's control. */
class FakeAudioContext extends EventTarget {
  static made: FakeAudioContext[] = [];

  state: AudioContextState = 'running';
  readonly destination = new FakeNode();
  readonly sources: HTMLMediaElement[] = [];
  readonly analysers: FakeAnalyser[] = [];
  readonly close = vi.fn(async () => undefined);
  readonly resume = vi.fn(async () => undefined);

  constructor() {
    super();
    FakeAudioContext.made.push(this);
  }

  createMediaElementSource(element: HTMLMediaElement): FakeNode {
    // A media element accepts one source in its lifetime, as in browsers.
    if (FakeAudioContext.made.some((context) => context.sources.includes(element))) {
      throw new DOMException('Already connected', 'InvalidStateError');
    }
    this.sources.push(element);
    return new FakeNode();
  }

  createAnalyser(): FakeAnalyser {
    const analyser = new FakeAnalyser();
    this.analysers.push(analyser);
    return analyser;
  }
}

@Component({
  imports: [MicrophonePanel],
  providers: [MicTest],
  // One panel per microphone, as the page builds them: another microphone replaces the panel.
  template: `
    @if (shown()) {
      @for (mic of [microphone()]; track mic.id) {
        <app-microphone-panel [microphone]="mic" [chip]="chip()" />
      }
    }
  `,
})
class Host {
  private readonly micTest = inject(MicTest);
  /** Whether the side panel shows the microphone; the page keeps its test either way. */
  readonly shown = signal(true);
  readonly microphone = signal<MicrophoneItem>(yeti);
  /** The chip as the page builds it: the device row's, with this page's test (ruling F23). */
  readonly chip = computed(() => {
    const test = this.micTest.state();
    const testing = test.status === 'recording' || test.status === 'playing' ? test.micId : null;
    return deviceRow(this.microphone(), { previewing: null, testing }).chip;
  });
}

describe('MicrophonePanel', () => {
  let http: HttpTestingController;
  let board: FakeBoard;
  let fixture: ComponentFixture<Host>;
  let play: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let pause: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    // The test's poll and its retries are timeouts: the test moves them on itself.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    FakeAudioContext.made = [];
    vi.stubGlobal('AudioContext', FakeAudioContext);
    // jsdom does not play media.
    play = vi.fn(async () => undefined);
    pause = vi.fn();
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(play);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(pause);
    board = new FakeBoard();
    board.state.set(boardState({ target: DEVKIT, generation: 3 }));
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: BoardService, useValue: board },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    try {
      fixture?.destroy();
      // Every request a test caused was answered and checked: a stray start or stop fails it.
      http.verify();
    } finally {
      // Restored even when the check fails, so that one failing test does not fail the next.
      vi.useRealTimers();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  /** Lets the requests and promise chains behind an answer run, then renders. */
  async function settle(): Promise<void> {
    for (let turn = 0; turn < 3; turn++) {
      await vi.advanceTimersByTimeAsync(0);
      await fixture.whenStable();
    }
  }

  /** Opens the panel; it reads the backend's test, which the caller answers. */
  async function open(microphone: MicrophoneItem = yeti): Promise<void> {
    fixture = TestBed.createComponent(Host);
    fixture.componentInstance.microphone.set(microphone);
    await settle();
  }

  /** Answers the status read sent now (the panel's resume, or a poll) with the backend's test. */
  async function answerRead(test: MicTestStatus | null): Promise<void> {
    http.expectOne({ method: 'GET', url: TEST_URL }).flush({ test });
    await settle();
  }

  async function answerStart(test: MicTestStatus): Promise<void> {
    const request = http.expectOne({ method: 'POST', url: TEST_URL });
    expect(request.request.body).toEqual({ id: yeti.id });
    request.flush({ test }, { status: 202, statusText: 'Accepted' });
    await settle();
  }

  async function nextPoll(): Promise<void> {
    await vi.advanceTimersByTimeAsync(MIC_TEST_POLL_MS);
    await settle();
  }

  /** Opens the Yeti's panel with no test on the board, and starts one that records. */
  async function record(): Promise<void> {
    await open();
    await answerRead(null);
    button().click();
    await settle();
    await answerStart(micTestStatus());
    await nextPoll();
    await answerRead(micTestStatus({ elapsed_ms: 4200, level_dbfs: -30 }));
  }

  const panel = (): HTMLElement =>
    (fixture.nativeElement as HTMLElement).querySelector('app-microphone-panel')!;
  const micTest = (): MicTest => fixture.debugElement.injector.get(MicTest);
  const title = (): string => panel().querySelector('h2')!.textContent!.trim();
  const titleChip = () => {
    const chip = fixture.debugElement.query(By.directive(NeatStatusChip));
    return { label: chip.nativeElement.textContent.trim(), tone: chip.componentInstance.tone() };
  };
  const notes = (): string[] =>
    [...panel().querySelectorAll(':scope > p[neatNote]')].map((note) => note.textContent!.trim());
  const headings = (): string[] =>
    [...panel().querySelectorAll(':scope > h3')].map((heading) => heading.textContent!.trim());
  const captureLines = (): string[] =>
    [...panel().querySelectorAll('.capture li')].map((line) => line.textContent!.trim());
  const button = (): HTMLButtonElement => panel().querySelector<HTMLButtonElement>('.test button')!;
  const replayButton = (): HTMLButtonElement | undefined =>
    [...panel().querySelectorAll<HTMLButtonElement>('.test button')].find(
      (candidate) => candidate.textContent!.trim() === 'Replay',
    );
  const caption = (): string => panel().querySelector('.caption')?.textContent?.trim() ?? '';
  const announced = (): string =>
    panel().querySelector('app-announcement')!.textContent!.trim();
  /** What the meter reads now: the level its `sample` gives, or null with none. */
  const meterReads = (): number | null | undefined => {
    const sample = fixture.debugElement.query(By.directive(NeatLevelMeter)).componentInstance.sample();
    return sample === null ? undefined : sample();
  };
  const audio = (): HTMLAudioElement => panel().querySelector('audio')!;
  const callouts = () =>
    [...panel().querySelectorAll<HTMLElement>(':scope > neat-callout')].map((callout) => ({
      tone: callout.getAttribute('tone'),
      announce: callout.getAttribute('role'),
      heading: callout.querySelector('[role="heading"]')?.textContent?.trim() ?? '',
      body: callout.querySelector('p')?.textContent?.trim() ?? '',
    }));

  it('shows the capture lines, or the no-formats text', async () => {
    await open(webcamMic);
    await answerRead(null);
    expect(title()).toBe('Yeti Nano');
    expect(titleChip()).toEqual({ label: 'Available', tone: 'success' });
    expect(notes()[0]).toBe('Part of HD Webcam C270');

    // Top to bottom: the title, Capture, the test, Details (closed until opened).
    const parts = [...panel().children]
      .filter((child) => !['APP-ANNOUNCEMENT', 'AUDIO'].includes(child.tagName))
      .map((child) => child.tagName.toLowerCase());
    expect(parts).toEqual(['app-panel-title', 'p', 'h3', 'ul', 'h3', 'div', 'app-device-details']);
    expect(headings()).toEqual(['Capture', 'Test Microphone']);
    expect(captureLines()).toEqual(['S24_3LE · 2 ch · 24-bit · 32 · 44.1 · 48 kHz']);
    expect(
      panel().querySelector('app-device-details button[aria-expanded]')?.getAttribute('aria-expanded'),
    ).toBe('false');
    fixture.destroy();

    // A device that does not report its formats, and one that lists none.
    await open(onboardMic);
    await answerRead(null);
    expect(notes()).toEqual(['This device does not report its capture formats.']);
    expect(panel().querySelector('.capture')).toBeNull();
    fixture.componentInstance.microphone.set({ ...onboardMic, capture: [] });
    await settle();
    expect(notes()).toEqual(['No capture formats listed.']);
  });

  it('records with the meter and the clock, plays back by itself, then offers Replay', async () => {
    await open();
    await answerRead(null);
    expect(button().textContent!.trim()).toBe('Test microphone');
    expect(meterReads()).toBeUndefined();
    expect(caption()).toBe('');
    expect(audio().hidden).toBe(true);

    button().click();
    // The click made the playback level over the panel's <audio>, while the gesture lasts
    // (ruling F11): the recording plays with no click of its own once it is in.
    expect(FakeAudioContext.made).toHaveLength(1);
    const [context] = FakeAudioContext.made;
    // Compared by identity: `toEqual` would match any audio element with the same attributes.
    expect(context.sources).toHaveLength(1);
    expect(context.sources[0]).toBe(audio());
    await settle();
    await answerStart(micTestStatus());
    await nextPoll();
    await answerRead(micTestStatus({ elapsed_ms: 4200, level_dbfs: -30 }));
    expect(button().textContent!.trim()).toBe('Stop recording');
    expect(caption()).toBe('Recording · 0:04');
    expect(announced()).toBe('Recording. Speak now, then press Stop recording.');
    expect(meterReads()).toBe(-30);

    // Stop waits for the board, keeping the focus (aria-disabled), and is sent once.
    button().click();
    await settle();
    expect(button().textContent!.trim()).toBe('Stopping…');
    expect(button().getAttribute('aria-disabled')).toBe('true');
    expect(button().disabled).toBe(false);
    button().click();
    await settle();
    const stop = http.expectOne({ method: 'POST', url: STOP_URL });
    expect(stop.request.body).toEqual({ token: 't1' });
    stop.flush({ test: micTestStatus() });
    await settle();
    await nextPoll();
    await answerRead(readyTest());

    // The recording plays by itself, and the meter follows it through the level made on the click.
    expect(audio().getAttribute('src')).toBe('/api/peripherals/microphones/test/t1.wav');
    expect(play).toHaveBeenCalledTimes(1);
    expect(button().textContent!.trim()).toBe('Stop playing');
    expect(button().hasAttribute('aria-disabled')).toBe(false);
    expect(caption()).toBe('Recording playing');
    expect(announced()).toBe('Recording playing.');
    context.analysers[0].level = 0.5;
    expect(meterReads()).toBeCloseTo(-6.02, 2);

    // Played to the end: Replay stands where the caption was, and the meter is dark.
    audio().dispatchEvent(new Event('ended'));
    await settle();
    expect(button().textContent!.trim()).toBe('Test microphone');
    expect(caption()).toBe('');
    expect(replayButton()).toBeDefined();
    expect(meterReads()).toBeUndefined();
    expect(callouts()).toEqual([]);

    // Replay plays it again through the same level: one context, one source for the element.
    replayButton()!.click();
    await settle();
    expect(play).toHaveBeenCalledTimes(2);
    expect(caption()).toBe('Recording playing');
    expect(meterReads()).toBeCloseTo(-6.02, 2);
    expect(FakeAudioContext.made).toHaveLength(1);
    expect(context.sources).toHaveLength(1);

    // Stop playing ends it here.
    const paused = pause.mock.calls.length;
    button().click();
    await settle();
    expect(pause).toHaveBeenCalledTimes(paused + 1);
    expect(replayButton()).toBeDefined();

    // The side panel closing mid-playback ends the playback and closes the level; opening it
    // again offers Replay.
    replayButton()!.click();
    await settle();
    expect(caption()).toBe('Recording playing');
    expect(context.close).not.toHaveBeenCalled();
    fixture.componentInstance.shown.set(false);
    await settle();
    expect(pause).toHaveBeenCalledTimes(paused + 2);
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(micTest().state().status).toBe('done');
    fixture.componentInstance.shown.set(true);
    await settle();
    http.expectNone(TEST_URL);
    expect(replayButton()).toBeDefined();
  });

  it('a panel opened mid-recording takes the recording up', async () => {
    await open();
    // Opening reads the board's test (`resume`): the Yeti is recording, started on another visit.
    await answerRead(micTestStatus({ token: 'other', elapsed_ms: 12_300, level_dbfs: -20 }));
    expect(button().textContent!.trim()).toBe('Stop recording');
    expect(caption()).toBe('Recording · 0:12');
    expect(meterReads()).toBe(-20);

    // Stop names the recording taken up.
    button().click();
    await settle();
    const stop = http.expectOne({ method: 'POST', url: STOP_URL });
    expect(stop.request.body).toEqual({ token: 'other' });
    stop.flush({ test: micTestStatus({ token: 'other' }) });
    await settle();
    await nextPoll();
    await answerRead(readyTest({ token: 'other' }));
    expect(caption()).toBe('Recording playing');
    audio().dispatchEvent(new Event('ended'));
    await settle();
    expect(replayButton()).toBeDefined();

    // The side panel closed and opened again: the finished recording is kept for Replay.
    fixture.componentInstance.shown.set(false);
    await settle();
    fixture.componentInstance.shown.set(true);
    await settle();
    http.expectNone(TEST_URL);
    expect(replayButton()).toBeDefined();

    // Another microphone's panel, then the Yeti's again: its recording is taken up from the
    // board, and Replay plays it in the new panel's element, with a level made on that click.
    fixture.componentInstance.microphone.set(onboardMic);
    await settle();
    await answerRead(readyTest({ token: 'other' }));
    expect(replayButton()).toBeUndefined();
    fixture.componentInstance.microphone.set(yeti);
    await settle();
    await answerRead(readyTest({ token: 'other' }));
    replayButton()!.click();
    await settle();
    expect(play.mock.contexts.at(-1)).toBe(audio());
    expect(FakeAudioContext.made.at(-1)!.sources[0]).toBe(audio());
    expect(caption()).toBe('Recording playing');
    button().click();
    await settle();

    // A Refresh listing the same device keeps it; the device's record or the board changing
    // starts afresh, reading the board's test again (ruling F12).
    fixture.componentInstance.microphone.set({ ...yeti, notes: ['Refreshed.'] });
    await settle();
    http.expectNone(TEST_URL);
    expect(replayButton()).toBeDefined();
    fixture.componentInstance.microphone.set({ ...yeti, record: 'b2' });
    await settle();
    expect(replayButton()).toBeUndefined();
    await answerRead(null);
    expect(button().textContent!.trim()).toBe('Test microphone');
    board.state.set(boardState({ target: DEVKIT, generation: 4 }));
    await settle();
    await answerRead(null);
    expect(button().textContent!.trim()).toBe('Test microphone');
  });

  it('a silent recording warns; microphone_in_use shows its hint', async () => {
    await record();
    await nextPoll();
    await answerRead(readyTest({ level: { peak_dbfs: null, rms_dbfs: null, silent: true } }));
    // Said once the playback is over, as #170 did.
    expect(callouts()).toEqual([]);
    audio().dispatchEvent(new Event('ended'));
    await settle();
    expect(callouts()).toEqual([
      {
        tone: 'warning',
        announce: 'alert',
        heading: '',
        body: "Nothing was picked up. Check the microphone's mute button and gain, then test again.",
      },
    ]);

    // The microphone is open in another application: the board's message, with the panel's hint.
    button().click();
    await settle();
    expect(callouts()).toEqual([]);
    http.expectOne({ method: 'POST', url: TEST_URL }).flush(
      {
        error: 'Open in arecord (pid 812).',
        code: 'microphone_in_use',
        hint: 'Close the other application.',
      },
      { status: 409, statusText: 'Conflict' },
    );
    await settle();
    expect(callouts()).toEqual([
      { tone: 'danger', announce: 'alert', heading: 'Open in arecord (pid 812).', body: IN_USE_HINT },
    ]);
    // The heading sits under "Test Microphone" in the outline.
    expect(panel().querySelector('neat-callout [role="heading"]')!.getAttribute('aria-level')).toBe(
      '4',
    );
    expect(button().textContent!.trim()).toBe('Test microphone');
    expect(button().hasAttribute('aria-disabled')).toBe(false);
  });

  // Review Focus 5: each leaves a usable button and an honest message.
  it('a failed stop keeps Stop and says why; a test that ends early says so', async () => {
    await record();
    button().click();
    await settle();
    http.expectOne({ method: 'POST', url: STOP_URL }).error(new ProgressEvent('error'));
    await settle();
    expect(button().textContent!.trim()).toBe('Stop recording');
    expect(button().hasAttribute('aria-disabled')).toBe(false);
    expect(caption()).toBe('Recording · 0:04');
    const [failure] = callouts();
    expect(failure).toMatchObject({ tone: 'danger', announce: 'alert' });
    expect(failure.heading).not.toBe('');

    // The board's test is gone before it finished (an Insight restart, another tab's test).
    await nextPoll();
    await answerRead(null);
    expect(callouts()).toEqual([
      {
        tone: 'danger',
        announce: 'alert',
        heading: 'The test ended before it finished.',
        body: 'Test again.',
      },
    ]);
    expect(button().textContent!.trim()).toBe('Test microphone');
    expect(caption()).toBe('');
    expect(meterReads()).toBeUndefined();
  });

  it('the row chip says Testing while this microphone records or plays', async () => {
    // F23: the rows' chips are the page's (its spec); the panel's title repeats the row's chip.
    await record();
    expect(titleChip()).toEqual({ label: 'Testing', tone: 'info' });
    await nextPoll();
    await answerRead(readyTest());
    expect(caption()).toBe('Recording playing');
    expect(titleChip()).toEqual({ label: 'Testing', tone: 'info' });
    audio().dispatchEvent(new Event('ended'));
    await settle();
    expect(titleChip()).toEqual({ label: 'Available', tone: 'success' });
  });
});
