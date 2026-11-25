import { HttpClient } from '@angular/common/http';
import { DestroyRef, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { boardUrl } from '../board/api';
import { problemOf } from '../board/board-error';
import { withRequestErrors } from '../sources/api-errors';
import type { MicrophoneItem, MicTestAnswer, MicTestRequest, MicTestStatus } from './api';
import {
  MIC_TEST_IDLE,
  MIC_TEST_POLL_MS,
  micStartMayHaveRun,
  micTestAfterFailedStart,
  micTestAudioUrl,
  type MicTestEvent,
  type MicTestState,
  micTestToResume,
  nextMicTestState,
  readMicTest,
  testEndedProblem,
} from './mic-test-state';

/**
 * Which test the page shows: a microphone of one scan on one board. A test belongs to exactly
 * this: another board's microphone with the same id, or another device a rescan lists under this
 * id, starts afresh.
 */
interface Shown {
  micId: string;
  board: string;
  record: string;
}

/** The test and the microphone it is shown for; `micId` is null before any. */
export type MicTestView = MicTestState & { micId: string | null };

/**
 * The microphone test of the Peripherals page, provided by the page: one test is shown at a time,
 * for the microphone whose panel is open. It composes the pure steps of `mic-test-state.ts` with
 * the requests, the status poll and the playback.
 *
 * **Recording.** The board records (`POST .../microphones/<id>/test`, the server's 30 s at most)
 * while the board's test (`GET .../microphones/test`) is read every 100 ms for its level and
 * clock. A failed read is retried up to 50 times; a read that finds the test gone, or failed,
 * says so.
 *
 * **Leaving.** Another microphone's panel, or leaving the page, stops reading but not the board's
 * recording; the microphone's panel takes it up again on return (`resume`).
 *
 * **Playback.** The panel gives the test its `<audio>` element (`attachAudio`). A finished
 * recording plays from 0 by itself and the test is done when it ends; Replay plays it again.
 */
@Injectable()
export class MicTest {
  private readonly http = inject(HttpClient);

  private readonly stateValue = signal<MicTestView>({ ...MIC_TEST_IDLE, micId: null });
  readonly state = this.stateValue.asReadonly();

  private readonly stoppingValue = signal(false);
  /** A stop was asked for and the board has not finished the recording yet. */
  readonly stopping = this.stoppingValue.asReadonly();

  private readonly elapsedValue = signal(0);
  /**
   * Whole seconds recorded, for the caption. Whole seconds, so that the 100 ms poll
   * changes it (and the panel's text) once a second.
   */
  readonly elapsed = this.elapsedValue.asReadonly();

  /** The latest recording level, in dBFS; null while not recording, and for digital silence. */
  private lastLevel: number | null = null;
  /**
   * The recording's level for the meter, which calls it every animation frame: a field read, no
   * signal, so a frame causes no change detection. An arrow function, since the meter calls it
   * unbound (`[sample]="micTest.level"`).
   */
  readonly level = (): number | null => this.lastLevel;

  private shown: Shown | null = null;
  /**
   * The id of the test last started or taken up here, for the shown microphone: a failed start
   * does not take up the recording that was shown before Test was pressed.
   */
  private heldId: string | null = null;
  /** The recording in progress here; null until its start answered. */
  private recording: MicTestStatus | null = null;
  /**
   * Counts the starts and resumes. A step resuming after an await goes on only while no newer one
   * began: an answer for an earlier microphone, board or test must not touch the one shown.
   */
  private run = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  /** Stop was pressed before the start answered: it is sent once the test's id is known. */
  private stopWanted = false;

  private audio: HTMLAudioElement | null = null;
  /** The recording the element holds, so that Replay does not load it again. */
  private loadedUrl: string | null = null;
  /** Counts the plays and pauses: a refused play ends only the playback it started. */
  private playback = 0;
  private readonly onEnded = () => this.dispatch({ type: 'played' });

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      // The page went: stop reading. The board's recording is left to finish; the next visit
      // takes it up.
      this.run++;
      this.clearPoll();
      this.attachAudio(null);
    });
  }

  /**
   * Records from `mic` on `board`. Resolves once the start has settled; never rejects, since a
   * failure is shown in `state`. A start whose answer was lost (a network failure, a gateway
   * error, or `test_running` from its own recording) takes up the board's recording for this
   * microphone instead of failing.
   */
  async start(mic: MicrophoneItem, board: string): Promise<void> {
    const run = this.begin(mic, board);
    this.dispatch({ type: 'record' });
    try {
      // The server records for its 30 s at most, until stopped.
      const body: MicTestRequest = {};
      const url = boardUrl(board, `microphones/${encodeURIComponent(mic.id)}/test`);
      const { test } = await firstValueFrom(
        this.http.post<MicTestAnswer>(url, body).pipe(withRequestErrors()),
      );
      if (run !== this.run) return;
      if (!test) throw problemOf(new Error('The board answered the test without it.'));
      this.hold({ ...test, board }, run);
    } catch (failure) {
      const error = problemOf(failure);
      let found: MicTestStatus | null = null;
      if (run === this.run && micStartMayHaveRun(error)) {
        try {
          const current = await this.current(run);
          found = micTestAfterFailedStart(mic.id, error, current, this.heldId);
        } catch {
          // The current test could not be read either: the start's own error is shown.
        }
      }
      if (run !== this.run) return;
      if (!found) {
        this.dispatch({ type: 'failed', error });
        return;
      }
      this.dispatch({ type: 'reset' });
      this.adopt(found, run);
    }
  }

  /**
   * Stops what the test is doing: the recording on the board, or the playback here. The board
   * ends the recording named by its id only, so a late Stop never ends a test another tab
   * started; the poll then takes the result up as usual. A failed stop keeps the test recording
   * with its failure, so Stop can be pressed again and the recording is still taken up when it
   * arrives.
   */
  async stop(): Promise<void> {
    const { status } = this.stateValue();
    if (status === 'playing') {
      this.dispatch({ type: 'played' });
      return;
    }
    if (status !== 'recording' || this.stoppingValue()) return;
    this.stoppingValue.set(true);
    if (this.recording === null) {
      this.stopWanted = true;
      return;
    }
    await this.sendStop(this.recording, this.run);
  }

  /** Plays the finished recording again, from the start. */
  replay(): void {
    this.dispatch({ type: 'replay' });
  }

  /**
   * Called when the panel of `mic` opens, and again when it shows another microphone, scan or
   * board. A test already shown for exactly this microphone is kept; otherwise the test starts
   * afresh and takes up the board's test when it is recording, or has a recording to replay, for
   * this microphone. A read that keeps failing leaves it idle.
   *
   * An idle or failed test starts afresh even for the same microphone, so a shown error (such as
   * `microphone_in_use` and its hint) is cleared and the board read again: right when the panel
   * opens. Call it on open and when the id, `record` or board changes, not whenever a new
   * `MicrophoneItem` object arrives for the same device (a Refresh), or the error would vanish.
   */
  async resume(mic: MicrophoneItem, board: string): Promise<void> {
    const status = this.stateValue().status;
    const keep = status === 'recording' || status === 'playing' || status === 'done';
    if (keep && sameShown(this.shown, shownOf(mic, board))) return;
    const run = this.begin(mic, board);
    let found: MicTestStatus | null;
    try {
      found = micTestToResume(mic.id, await this.current(run));
    } catch {
      return;
    }
    if (found && run === this.run) this.adopt(found, run);
  }

  /**
   * The panel's `<audio>` element, which the recording plays in; null when the panel goes. A
   * playback in the element that goes is over (removing a playing element from the page pauses
   * it), so the test is done and offers Replay.
   */
  attachAudio(audio: HTMLAudioElement | null): void {
    if (audio === this.audio) return;
    if (this.audio) {
      this.pause();
      this.audio.removeEventListener('ended', this.onEnded);
    }
    this.audio = audio;
    this.loadedUrl = null;
    audio?.addEventListener('ended', this.onEnded);
    this.dispatch({ type: 'played' });
  }

  /**
   * Starts showing a test for `mic` on `board`: what was shown before is let go of (its poll
   * stops; its recording, if any, goes on on the board), and the test is idle until the caller
   * starts or takes one up. Returns the run the caller's steps belong to.
   */
  private begin(mic: MicrophoneItem, board: string): number {
    const shown = shownOf(mic, board);
    if (!sameShown(this.shown, shown)) this.heldId = null;
    this.shown = shown;
    this.recording = null;
    this.run++;
    this.clearPoll();
    this.stopWanted = false;
    this.elapsedValue.set(0);
    this.dispatch({ type: 'reset' });
    return this.run;
  }

  /**
   * A recording this page started or took up, with its latest status: read it again in 100 ms,
   * and send a Stop pressed before its id was known.
   */
  private hold(test: MicTestStatus, run: number): void {
    this.heldId = test.id;
    this.recording = test;
    this.showProgress(test);
    this.schedulePoll(test.id, run);
    if (this.stopWanted) {
      this.stopWanted = false;
      // A failed start that took up this recording reset the test, and `stopping` with it.
      this.stoppingValue.set(true);
      void this.sendStop(test, run);
    }
  }

  /** Shows a test this page did not start, and reads it while it records. */
  private adopt(test: MicTestStatus, run: number): void {
    this.dispatch({ type: 'resume', test });
    if (test.state === 'recording') this.hold(test, run);
    else this.heldId = test.id;
  }

  private async sendStop(test: MicTestStatus, run: number): Promise<void> {
    const url = boardUrl(
      test.board,
      `microphones/${encodeURIComponent(test.microphone)}/test/stop`,
    );
    try {
      await firstValueFrom(
        this.http
          .post<MicTestAnswer>(url, {}, { params: { test: test.id } })
          .pipe(withRequestErrors()),
      );
    } catch (failure) {
      if (run !== this.run) return;
      this.dispatch({ type: 'stop-failed', error: problemOf(failure) });
      this.stoppingValue.set(false);
    }
  }

  /** Reads test `id`, and again every 100 ms until its recording is in or it failed. */
  private async poll(id: string, run: number): Promise<void> {
    let test: MicTestStatus | null;
    try {
      test = await this.current(run);
    } catch (failure) {
      if (run === this.run) this.dispatch({ type: 'failed', error: problemOf(failure) });
      return;
    }
    if (run !== this.run) return;
    if (!test || test.id !== id) {
      this.dispatch({ type: 'failed', error: testEndedProblem() });
    } else if (test.state === 'recording') {
      this.showProgress(test);
      this.schedulePoll(id, run);
    } else if (test.state === 'ready') {
      this.dispatch({ type: 'recorded', test });
    } else {
      this.dispatch({ type: 'failed', error: problemOf(test.error ?? {}) });
    }
  }

  private schedulePoll(id: string, run: number): void {
    this.pollTimer = setTimeout(() => void this.poll(id, run), MIC_TEST_POLL_MS);
  }

  private showProgress(test: MicTestStatus): void {
    // Absent while recording means digital silence, which the meter shows dark.
    this.lastLevel = test.level_dbfs ?? null;
    this.elapsedValue.set(Math.floor(test.elapsed_ms / 1000));
  }

  /**
   * The board's test for the shown board; null when none. A failed read is retried while `run`
   * is the latest (`readMicTest`); rejects with a `BoardProblem` when it gives up.
   */
  private current(run: number): Promise<MicTestStatus | null> {
    return readMicTest({ request: () => this.read(), isActive: () => run === this.run });
  }

  private async read(): Promise<MicTestStatus | null> {
    const board = this.shown?.board;
    if (!board) return null;
    try {
      const { test } = await firstValueFrom(
        this.http.get<MicTestAnswer>(boardUrl(board, 'microphones/test')).pipe(withRequestErrors()),
      );
      return test ? { ...test, board } : null;
    } catch (failure) {
      throw problemOf(failure);
    }
  }

  private clearPoll(): void {
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  private dispatch(event: MicTestEvent): void {
    const previous = this.stateValue();
    const next = nextMicTestState(previous, event);
    if (next === previous) return;
    this.stateValue.set({ ...next, micId: this.shown?.micId ?? null });
    if (next.status !== 'recording') {
      this.lastLevel = null;
      this.stoppingValue.set(false);
    }
    if (previous.status === 'playing' && next.status !== 'playing') this.pause();
    if (next.status === 'playing' && previous.status !== 'playing') this.play(next.test);
  }

  /**
   * Plays the finished recording from 0. Without an element (no panel shows the test) there is
   * nothing to play it in, so it is done at once and Replay offers it.
   */
  private play(test: MicTestStatus | null): void {
    const audio = this.audio;
    if (!audio || test?.state !== 'ready') {
      this.dispatch({ type: 'played' });
      return;
    }
    const url = micTestAudioUrl(test);
    const playback = ++this.playback;
    if (this.loadedUrl === url) {
      try {
        audio.currentTime = 0;
      } catch {
        // Some browsers refuse a seek before the file has loaded; an ended playback then starts
        // over from 0 on play() anyway.
      }
    } else {
      // A new source starts at 0; a seek before it has loaded is refused by some browsers.
      audio.src = url;
      this.loadedUrl = url;
    }
    // A play the browser refuses (autoplay rules, an undecodable file) ends this playback.
    audio.play().catch(() => {
      if (playback === this.playback) this.dispatch({ type: 'played' });
    });
  }

  private pause(): void {
    this.playback++;
    this.audio?.pause();
  }
}

function shownOf(mic: MicrophoneItem, board: string): Shown {
  return { micId: mic.id, board, record: mic.record };
}

function sameShown(a: Shown | null, b: Shown): boolean {
  return a?.micId === b.micId && a.board === b.board && a.record === b.record;
}
