import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, computed, inject, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { NeatLevelMeter } from '@sima/neat-ui/level-meter';
import { NeatStatusChip } from '@sima/neat-ui/status-chip';
import { boardUrl } from '../../board/api';
import { BoardService } from '../../board/board.service';
import { boardWith, DEVKIT, FakeBoard, MANUAL } from '../../board/board.testing';
import type { MicrophoneItem, MicTestStatus } from '../../peripherals/api';
import { usb } from '../../peripherals/cameras.testing';
import { deviceRow } from '../../peripherals/devices';
import { MicTest } from '../../peripherals/mic-test';
import { MIC_TEST_POLL_MS } from '../../peripherals/mic-test-state';
import {
  micTestStatus,
  onboardMic,
  readyTest,
  testAudioUrl,
  yeti,
} from '../../peripherals/microphones.testing';
import { MicrophonePanel } from './microphone-panel';

const TEST_URL = boardUrl(DEVKIT.id, 'microphones/test');
const START_URL = boardUrl(DEVKIT.id, `microphones/${encodeURIComponent(yeti.id)}/test`);
/** The stop of the Yeti's test `id`, which names the test. */
const stopUrl = (id: string) => `${START_URL}/stop?test=${id}`;
/** The error shape the server answers with. */
const failure = (code: string, message: string, hint: string) => ({
  error: { code, message, hint },
});

/** The webcam's microphone: the same USB device as the C270 camera. */
const webcamMic: MicrophoneItem = {
  ...yeti,
  device: { ...yeti.device, part_of: { id: usb.id, name: usb.name } },
};

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
  /** The chip as the page builds it: the device row's, with this page's test. */
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
    // jsdom does not play media.
    play = vi.fn(async () => undefined);
    pause = vi.fn();
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(play);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(pause);
    board = new FakeBoard();
    board.state.set(boardWith(DEVKIT));
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

  /** Answers the status read sent now (the panel's resume, or a poll) with the board's test. */
  async function answerRead(test: MicTestStatus | null, url = TEST_URL): Promise<void> {
    http.expectOne({ method: 'GET', url }).flush({ test });
    await settle();
  }

  async function answerStart(test: MicTestStatus): Promise<void> {
    const request = http.expectOne({ method: 'POST', url: START_URL });
    expect(request.request.body).toEqual({});
    request.flush({ test }, { status: 202, statusText: 'Accepted' });
    await settle();
  }

  /** Expects the stop of test `id`. */
  const expectStop = (id: string) =>
    http.expectOne((request) => request.method === 'POST' && request.urlWithParams === stopUrl(id));

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
  const announced = (): string => panel().querySelector('app-announcement')!.textContent!.trim();
  /** What the meter reads now: the level its `sample` gives, or null with none. */
  const meterReads = (): number | null | undefined => {
    const sample = fixture.debugElement
      .query(By.directive(NeatLevelMeter))
      .componentInstance.sample();
    return sample === null ? undefined : sample();
  };
  const audio = (): HTMLAudioElement => panel().querySelector('audio')!;
  const callouts = () =>
    [
      ...panel().querySelectorAll<HTMLElement>(
        ':scope > neat-callout, :scope > app-device-errors > neat-callout',
      ),
    ].map((callout) => ({
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
    expect(parts).toEqual([
      'app-panel-title',
      'p',
      'app-device-errors',
      'h3',
      'ul',
      'h3',
      'div',
      'app-device-details',
    ]);
    expect(headings()).toEqual(['Capture', 'Test Microphone']);
    expect(captureLines()).toEqual(['S24_3LE · 2 ch · 24-bit · 32 · 44.1 · 48 kHz']);
    expect(
      panel()
        .querySelector('app-device-details button[aria-expanded]')
        ?.getAttribute('aria-expanded'),
    ).toBe('false');

    // A problem reported with the device shows under the title.
    fixture.componentInstance.microphone.set({
      ...webcamMic,
      errors: [
        {
          code: 'capture_unreadable',
          message: 'The capture formats could not be read.',
          hint: 'Replug the microphone, then refresh.',
        },
      ],
    });
    await settle();
    expect(callouts()).toEqual([
      {
        tone: 'danger',
        announce: null,
        heading: 'The capture formats could not be read.',
        body: 'Replug the microphone, then refresh.',
      },
    ]);
    expect(
      panel().querySelector('app-device-errors')!.previousElementSibling!.textContent!.trim(),
    ).toBe('Part of HD Webcam C270');
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
    expectStop('t1').flush({ test: micTestStatus() });
    await settle();
    await nextPoll();
    await answerRead(readyTest());

    // The recording plays by itself; the meter is dark, as it is for anything but a recording.
    expect(audio().getAttribute('src')).toBe(testAudioUrl('t1'));
    expect(play).toHaveBeenCalledTimes(1);
    expect(button().textContent!.trim()).toBe('Stop playing');
    expect(button().hasAttribute('aria-disabled')).toBe(false);
    expect(caption()).toBe('Recording playing');
    expect(announced()).toBe('Recording playing.');
    expect(meterReads()).toBeUndefined();

    // Played to the end: Replay stands where the caption was.
    audio().dispatchEvent(new Event('ended'));
    await settle();
    expect(button().textContent!.trim()).toBe('Test microphone');
    expect(caption()).toBe('');
    expect(replayButton()).toBeDefined();
    expect(meterReads()).toBeUndefined();
    expect(callouts()).toEqual([]);

    // Replay plays it again.
    replayButton()!.click();
    await settle();
    expect(play).toHaveBeenCalledTimes(2);
    expect(caption()).toBe('Recording playing');

    // Stop playing ends it here.
    const paused = pause.mock.calls.length;
    button().click();
    await settle();
    expect(pause).toHaveBeenCalledTimes(paused + 1);
    expect(replayButton()).toBeDefined();

    // The side panel closing mid-playback ends the playback; opening it again offers Replay.
    replayButton()!.click();
    await settle();
    expect(caption()).toBe('Recording playing');
    fixture.componentInstance.shown.set(false);
    await settle();
    expect(pause).toHaveBeenCalledTimes(paused + 2);
    expect(micTest().state().status).toBe('done');
    fixture.componentInstance.shown.set(true);
    await settle();
    http.expectNone(TEST_URL);
    expect(replayButton()).toBeDefined();
  });

  it('a panel opened mid-recording takes the recording up', async () => {
    await open();
    // Opening reads the board's test (`resume`): the Yeti is recording, started on another visit.
    await answerRead(micTestStatus({ id: 'other', elapsed_ms: 12_300, level_dbfs: -20 }));
    expect(button().textContent!.trim()).toBe('Stop recording');
    expect(caption()).toBe('Recording · 0:12');
    expect(meterReads()).toBe(-20);

    // Stop names the recording taken up.
    button().click();
    await settle();
    expectStop('other').flush({ test: micTestStatus({ id: 'other' }) });
    await settle();
    await nextPoll();
    await answerRead(readyTest({ id: 'other' }));
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
    // board, and Replay plays it in the new panel's element.
    fixture.componentInstance.microphone.set(onboardMic);
    await settle();
    await answerRead(readyTest({ id: 'other' }));
    expect(replayButton()).toBeUndefined();
    fixture.componentInstance.microphone.set(yeti);
    await settle();
    await answerRead(readyTest({ id: 'other' }));
    replayButton()!.click();
    await settle();
    // Compared by identity: `toEqual` would match any audio element with the same attributes.
    expect(play.mock.contexts.at(-1)).toBe(audio());
    expect(caption()).toBe('Recording playing');
    button().click();
    await settle();

    // A Refresh listing the same device keeps it; the device's record or the board changing
    // starts afresh, reading the board's test again.
    fixture.componentInstance.microphone.set({ ...yeti, notes: ['Refreshed.'] });
    await settle();
    http.expectNone(TEST_URL);
    expect(replayButton()).toBeDefined();
    fixture.componentInstance.microphone.set({ ...yeti, record: 'b2' });
    await settle();
    expect(replayButton()).toBeUndefined();
    await answerRead(null);
    expect(button().textContent!.trim()).toBe('Test microphone');
    board.state.set(boardWith(MANUAL));
    await settle();
    await answerRead(null, boardUrl(MANUAL.id, 'microphones/test'));
    expect(button().textContent!.trim()).toBe('Test microphone');
  });

  it('a silent recording warns; microphone_in_use shows its hint', async () => {
    await record();
    await nextPoll();
    await answerRead(readyTest({ level: { peak_dbfs: null, rms_dbfs: null, silent: true } }));
    // Said once the playback is over.
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

    // The microphone is open in another application: the board's message, with its hint.
    button().click();
    await settle();
    expect(callouts()).toEqual([]);
    http
      .expectOne({ method: 'POST', url: START_URL })
      .flush(
        failure('microphone_in_use', 'Open in arecord (pid 812).', 'Close the other application.'),
        { status: 409, statusText: 'Conflict' },
      );
    await settle();
    expect(callouts()).toEqual([
      {
        tone: 'danger',
        announce: 'alert',
        heading: 'Open in arecord (pid 812).',
        body: 'Close the other application.',
      },
    ]);
    // The heading sits under "Test Microphone" in the outline.
    expect(panel().querySelector('neat-callout [role="heading"]')!.getAttribute('aria-level')).toBe(
      '4',
    );
    expect(button().textContent!.trim()).toBe('Test microphone');
    expect(button().hasAttribute('aria-disabled')).toBe(false);
  });

  // Each leaves a usable button and an honest message.
  it('a failed stop keeps Stop and says why; a test that ends early says so', async () => {
    await record();
    button().click();
    await settle();
    expectStop('t1').error(new ProgressEvent('error'));
    await settle();
    expect(button().textContent!.trim()).toBe('Stop recording');
    expect(button().hasAttribute('aria-disabled')).toBe(false);
    expect(caption()).toBe('Recording · 0:04');
    // The stop's answer was lost on the way: the network words.
    expect(callouts()).toEqual([
      {
        tone: 'danger',
        announce: 'alert',
        heading: 'Could not reach the Insight server.',
        body: 'Check that Insight is still running, then retry.',
      },
    ]);

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
    // The rows' chips are the page's (its spec); the panel's title repeats the row's chip.
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
