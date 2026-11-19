/**
 * The microphone test as a state machine, and the words and steps around it, as pure functions.
 * `MicTest` composes them.
 *
 * Like a video call's "Test microphone": the board records until Stop (or the server's cap of
 * 30 s) while a meter shows the live level, then the recording plays back here with the meter
 * following the playback. The server runs one test per board.
 */

import { boardUrl } from '../board/api';
import { BoardProblem } from '../board/board-error';
import { clock } from '../sources/fps';
import type { MicLevel, MicrophoneItem, MicTestStatus } from './api';

export type MicTestPhase = 'idle' | 'recording' | 'playing' | 'done' | 'error';

/**
 * What the test shows. `test` is the board's finished test (its recording and levels) while it
 * plays or is done. `error` is why the test failed, or, while still recording, why a stop failed.
 */
export interface MicTestState {
  status: MicTestPhase;
  test: MicTestStatus | null;
  error: BoardProblem | null;
}

export type MicTestEvent =
  | { type: 'record' }
  /** The board's recording is in: it plays back by itself. */
  | { type: 'recorded'; test: MicTestStatus }
  | { type: 'failed'; error: BoardProblem }
  /** The board may still be recording: Stop stays, and the result is taken up when it comes. */
  | { type: 'stop-failed'; error: BoardProblem }
  /** The playback ended, or Stop playing. */
  | { type: 'played' }
  | { type: 'replay' }
  /** A test the backend was already running, or finished, for this microphone. */
  | { type: 'resume'; test: MicTestStatus }
  | { type: 'reset' };

/** What pressing the test's one button does. */
export type MicTestActionName = 'record' | 'stop' | 'stop-playing';

export interface MicTestAction {
  label: string;
  action: MicTestActionName;
  disabled: boolean;
}

/** One capture combination as its badges, e.g. `S24_3LE`, `2 ch`, `24-bit`, `32 · 44.1 · 48 kHz`. */
export interface CaptureMode {
  key: string;
  badges: string[];
}

/** How often a recording's status is read; the read never contacts the board. */
export const MIC_TEST_POLL_MS = 100;

/** Failed reads in a row that end a recording: about 5 s at the poll's pace. */
export const MIC_TEST_MAX_FAILURES = 50;

export const MIC_TEST_IDLE: MicTestState = Object.freeze({
  status: 'idle',
  test: null,
  error: null,
});

const SILENCE_NOTICE =
  "Nothing was picked up. Check the microphone's mute button and gain, then test again.";

/** The status read's codes that mean the test is gone (its board was replaced), so retrying is pointless. */
const TERMINAL_STATUS_CODES: ReadonlySet<string> = new Set(['not_found', 'board_changed']);

export function nextMicTestState(state: MicTestState, event: MicTestEvent): MicTestState {
  switch (event.type) {
    case 'record':
      return { status: 'recording', test: null, error: null };
    case 'recorded':
      return state.status === 'recording'
        ? { status: 'playing', test: event.test, error: null }
        : state;
    case 'failed':
      return state.status === 'recording'
        ? { status: 'error', test: null, error: event.error }
        : state;
    case 'stop-failed':
      return state.status === 'recording' ? { ...state, error: event.error } : state;
    case 'played':
      return state.status === 'playing' ? { ...state, status: 'done' } : state;
    case 'replay':
      return state.status === 'done' ? { ...state, status: 'playing' } : state;
    case 'resume':
      if (state.status !== 'idle') return state;
      return event.test.state === 'recording'
        ? { status: 'recording', test: null, error: null }
        : { status: 'done', test: event.test, error: null };
    case 'reset':
      return MIC_TEST_IDLE;
  }
}

/**
 * The board's current test when it belongs to this microphone and is still recording or has a
 * recording to replay. A panel opened after it started (another microphone was shown in between)
 * takes it up instead of looking idle while the board records.
 */
export function micTestToResume(micId: string, test: MicTestStatus | null): MicTestStatus | null {
  if (!test || test.microphone !== micId) return null;
  return test.state === 'recording' || test.state === 'ready' ? test : null;
}

/** A finished test's recording, which names the test so that one replaced since is not played. */
export function micTestAudioUrl(test: MicTestStatus): string {
  const path = `microphones/${encodeURIComponent(test.microphone)}/test.wav`;
  return `${boardUrl(test.board, path)}?test=${encodeURIComponent(test.id)}`;
}

/**
 * A start that failed without the backend's answer (the connection dropped, or a gateway replied
 * without an API body) may still have started recording, and a retry is then refused with
 * `test_running`. Only these failures read the backend's current test.
 */
export function micStartMayHaveRun(error: Pick<BoardProblem, 'code'>): boolean {
  return ['network', 'test_running', ''].includes(error.code);
}

/**
 * The board's test a failed start takes up: the current test for this microphone when it is not
 * the one the panel already held (`heldId`); otherwise null, and the start's error stands.
 */
export function micTestAfterFailedStart(
  micId: string,
  error: Pick<BoardProblem, 'code'>,
  test: MicTestStatus | null,
  heldId: string | null,
): MicTestStatus | null {
  if (!micStartMayHaveRun(error)) return null;
  return test?.id === heldId ? null : micTestToResume(micId, test);
}

/** What to say about a finished recording: only when it needs attention. */
export function micLevelNotice(level: MicLevel | null | undefined): string {
  return level?.silent ? SILENCE_NOTICE : '';
}

/** The recovery line under a test's error: the panel's own for the codes it knows. */
export function micTestErrorAction(error: Pick<BoardProblem, 'code' | 'hint'> | null): string {
  switch (error?.code) {
    case 'microphone_in_use':
      return 'Stop the application that is recording from it, then test again. Insight never stops it for you.';
    case 'not_found':
    case 'board_changed':
      return 'Refresh, then test again.';
    case 'tool_missing':
      return 'Install alsa-utils on the board, then test again.';
    default:
      return error?.hint ?? '';
  }
}

/** The one button's label and what pressing it does, for each state. */
export function micTestAction(status: MicTestPhase, stopping: boolean): MicTestAction {
  if (status === 'recording') {
    return { label: stopping ? 'Stopping…' : 'Stop recording', action: 'stop', disabled: stopping };
  }
  if (status === 'playing')
    return { label: 'Stop playing', action: 'stop-playing', disabled: false };
  return { label: 'Test microphone', action: 'record', disabled: false };
}

/** The caption beside the meter: the recording's clock, or that it plays; '' otherwise. */
export function micTestCaption(status: MicTestPhase, seconds: number): string {
  if (status === 'recording') return `Recording · ${clock(seconds)}`;
  return status === 'playing' ? 'Recording playing' : '';
}

/** The problem shown when the board no longer runs the test this panel read. */
export function testEndedProblem(): BoardProblem {
  return new BoardProblem('The test ended before it finished.', '', 'Test again.');
}

export function sampleRateLabel(hz: number): string {
  const khz = hz / 1000;
  return `${Number.isInteger(khz) ? khz : Number(khz.toFixed(3))} kHz`;
}

/**
 * One row per distinct capture combination the device reports. A continuous rate range stays a
 * range ("8–48 kHz"): expanding it into a list would invent rates the device never named. Null
 * when the device does not report its formats.
 */
export function captureModes(mic: Pick<MicrophoneItem, 'capture'>): CaptureMode[] | null {
  if (!Array.isArray(mic.capture)) return null;
  return mic.capture.map((mode, index) => {
    const rates = mode.rate_range
      ? `${khzNumber(mode.rate_range.min)}–${sampleRateLabel(mode.rate_range.max)}`
      : rateList(mode.rates);
    const badges = [
      mode.format ?? '',
      Number.isFinite(mode.channels) ? `${mode.channels} ch` : '',
      Number.isFinite(mode.bits) ? `${mode.bits}-bit` : '',
      rates,
    ].filter(Boolean);
    return { key: `${index}-${mode.format}-${mode.channels}-${mode.bits}`, badges };
  });
}

/**
 * Reads the board's current test, retrying a failed read. The read never contacts the board, so
 * a failure is a network blip or an Insight restart, not the end of the recording. Codes that mean
 * the test is gone end it at once, and so does a run of `maxFailures` failures. `isActive` says
 * whether anyone still wants the answer: a page that went sends no further read.
 */
export async function readMicTest({
  request,
  isActive = () => true,
  wait = () => new Promise((resolve) => setTimeout(resolve, MIC_TEST_POLL_MS)),
  maxFailures = MIC_TEST_MAX_FAILURES,
}: {
  request: () => Promise<MicTestStatus | null>;
  isActive?: () => boolean;
  wait?: () => Promise<unknown>;
  maxFailures?: number;
}): Promise<MicTestStatus | null> {
  for (let failures = 1; ; failures++) {
    try {
      return await request();
    } catch (error) {
      if (terminal(error) || failures >= maxFailures || !isActive()) throw error;
      await wait();
      if (!isActive()) throw error;
    }
  }
}

function terminal(error: unknown): boolean {
  return error instanceof BoardProblem && TERMINAL_STATUS_CODES.has(error.code);
}

function khzNumber(hz: number): string {
  return sampleRateLabel(hz).replace(' kHz', '');
}

function rateList(rates: readonly number[]): string {
  return rates.length ? `${rates.map(khzNumber).join(' · ')} kHz` : '';
}
