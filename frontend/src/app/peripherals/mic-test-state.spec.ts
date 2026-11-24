import { BoardProblem } from '../board/board-error';
import type { MicrophoneItem, MicTestStatus } from './api';
import { deviceRow } from './devices';
import {
  captureModes,
  MIC_TEST_IDLE,
  micLevelNotice,
  micStartMayHaveRun,
  micTestAction,
  micTestAfterFailedStart,
  micTestAudioUrl,
  micTestCaption,
  micTestToResume,
  nextMicTestState,
  readMicTest,
  sampleRateLabel,
} from './mic-test-state';
import { micTestStatus, onboardMic, readyTest, testAudioUrl, yeti } from './microphones.testing';

const problem = (code: string, message = code, hint = '') => new BoardProblem(message, code, hint);
const noActivity = { previewing: null, testing: null };

describe('mic-test-state', () => {
  it('the real Yeti Nano reads as capture tags', () => {
    expect(deviceRow(yeti, noActivity).subtitle).toBe(''); // the ALSA name is not shown under the title
    expect(captureModes(yeti)).toEqual([
      { key: '0-S24_3LE-2-24', badges: ['S24_3LE', '2 ch', '24-bit', '32 · 44.1 · 48 kHz'] },
    ]);
  });

  it('capture tags cover mono, several formats, single rates and continuous ranges', () => {
    const modes = captureModes({
      capture: [
        {
          format: 'S32_LE',
          channels: 2,
          bits: 24,
          rates: [44100, 48000, 88200, 96000],
          channel_map: ['FL', 'FR'],
        },
        {
          format: 'S16_LE',
          channels: 1,
          bits: 16,
          rates: [16000],
          channel_map: ['MONO'],
        },
        {
          format: 'S24_3LE',
          channels: 1,
          bits: 24,
          rates: [],
          rate_range: { min: 8000, max: 48000 },
        },
        {
          format: 'S16_LE',
          channels: 1,
          bits: 16,
          rates: [11025],
          rate_range: { min: 11025, max: 96000 },
        },
      ],
    });
    // A continuous range stays one range.
    expect(modes?.map((mode) => mode.badges)).toEqual([
      ['S32_LE', '2 ch', '24-bit', '44.1 · 48 · 88.2 · 96 kHz'],
      ['S16_LE', '1 ch', '16-bit', '16 kHz'],
      ['S24_3LE', '1 ch', '24-bit', '8–48 kHz'],
      ['S16_LE', '1 ch', '16-bit', '11.025–96 kHz'],
    ]);
    // A field the kernel did not print is left out, not shown empty.
    expect(
      captureModes({
        capture: [{ rates: [] }],
      })?.[0]?.badges,
    ).toEqual([]);
    // Every combination keeps its own row.
    expect(new Set(modes?.map((mode) => mode.key)).size).toBe(4);
    expect(sampleRateLabel(22050)).toBe('22.05 kHz');
  });

  it('a card without readable capabilities omits its capture modes', () => {
    expect(captureModes(onboardMic)).toBeNull();
    expect(captureModes({ capture: [] })).toEqual([]);
    const bare: MicrophoneItem = {
      ...yeti,
      name: 'USB Device 0x1234:0x5678',
      device: {
        card_index: 3,
        pcm_device: 0,
        pcm_node: '/dev/snd/pcmC3D0c',
        usb: { vendor_id: '1234', product_id: '5678', bus_path: '1-2' },
      },
    };
    expect(deviceRow(bare, noActivity).subtitle).toBe('');
  });

  it('microphone test: record, play back, replay, and never a late answer out of turn', () => {
    const recording = nextMicTestState(MIC_TEST_IDLE, { type: 'record' });
    expect(recording.status).toBe('recording');
    const test = readyTest({ id: 'a' });
    const playing = nextMicTestState(recording, { type: 'recorded', test });
    expect(playing).toEqual({ status: 'playing', test, error: null }); // playback starts by itself
    const done = nextMicTestState(playing, { type: 'played' });
    expect(done.status).toBe('done');
    expect(nextMicTestState(done, { type: 'replay' }).status).toBe('playing');
    expect(nextMicTestState(recording, { type: 'replay' })).toBe(recording); // nothing to replay while recording
    const failed = nextMicTestState(recording, {
      type: 'failed',
      error: problem('microphone_in_use'),
    });
    expect(failed.status).toBe('error');
    // An answer nobody is waiting for is dropped.
    expect(nextMicTestState(MIC_TEST_IDLE, { type: 'recorded', test })).toBe(MIC_TEST_IDLE);
    expect(nextMicTestState(done, { type: 'failed', error: problem('') })).toBe(done);
    // Test again from a finished test.
    expect(nextMicTestState(done, { type: 'record' }).status).toBe('recording');
    expect(nextMicTestState(failed, { type: 'reset' })).toEqual(MIC_TEST_IDLE);
  });

  it('microphone test: a failed stop keeps the test recording, so Stop can be retried and the recording is taken up', () => {
    const recording = nextMicTestState(MIC_TEST_IDLE, { type: 'record' });
    const error = problem('network', 'Could not reach Insight.');
    const stopFailed = nextMicTestState(recording, { type: 'stop-failed', error });
    expect(stopFailed).toEqual({ status: 'recording', test: null, error });
    const test = readyTest({ id: 'a' });
    expect(nextMicTestState(stopFailed, { type: 'recorded', test })).toEqual({
      status: 'playing',
      test,
      error: null,
    });
    const done = { status: 'done' as const, test, error: null };
    expect(nextMicTestState(done, { type: 'stop-failed', error })).toBe(done); // only a recording test is stopped
  });

  it("microphone test: a detail mounted mid-test takes up the board's test for its own microphone", () => {
    const recording = micTestStatus({ id: 't', elapsed_ms: 1200, level_dbfs: -20 });
    const ready = readyTest({ id: 't' });
    expect(micTestToResume(yeti.id, recording)).toBe(recording);
    // A recording finished while another mic was shown is kept.
    expect(micTestToResume(yeti.id, ready)).toBe(ready);
    // Another microphone's test is not shown here.
    expect(micTestToResume(onboardMic.id, recording)).toBeNull();
    expect(micTestToResume(yeti.id, { ...recording, state: 'failed' })).toBeNull();
    expect(micTestToResume(yeti.id, null)).toBeNull();
    expect(nextMicTestState(MIC_TEST_IDLE, { type: 'resume', test: recording })).toEqual({
      status: 'recording',
      test: null,
      error: null,
    });
    expect(nextMicTestState(MIC_TEST_IDLE, { type: 'resume', test: ready })).toEqual({
      status: 'done',
      test: ready,
      error: null,
    });
    const started = nextMicTestState(MIC_TEST_IDLE, { type: 'record' });
    // A test started here is not replaced.
    expect(nextMicTestState(started, { type: 'resume', test: ready })).toBe(started);
  });

  it('microphone test: a start whose answer was lost takes up the recording it began', () => {
    const recording = micTestStatus({ id: 'new', elapsed_ms: 400, level_dbfs: -30 });
    const ready = { ...recording, state: 'ready' as const };
    const lost = problem('network', 'Could not reach the Insight server.');
    expect(micTestAfterFailedStart(yeti.id, lost, recording, null)).toBe(recording);
    // A retry refused by its own recording.
    expect(micTestAfterFailedStart(yeti.id, problem('test_running'), recording, 'old')).toBe(
      recording,
    );
    // A gateway error without an API body.
    expect(micTestAfterFailedStart(yeti.id, problem('', 'Request failed: 504'), ready, null)).toBe(
      ready,
    );
    // The recording shown before Test is not new.
    expect(micTestAfterFailedStart(yeti.id, lost, { ...ready, id: 'old' }, 'old')).toBeNull();
    // Another microphone is recording.
    expect(
      micTestAfterFailedStart(onboardMic.id, problem('test_running'), recording, null),
    ).toBeNull();
    expect(
      micTestAfterFailedStart(yeti.id, lost, { ...recording, state: 'failed' }, null),
    ).toBeNull();
    expect(micTestAfterFailedStart(yeti.id, lost, null, null)).toBeNull();
    // The backend answered: its error stands.
    expect(
      micTestAfterFailedStart(yeti.id, problem('microphone_in_use'), recording, null),
    ).toBeNull();
    // Only these read the current test.
    expect(
      [lost, problem('test_running'), problem(''), problem('not_found')].map(micStartMayHaveRun),
    ).toEqual([true, true, true, false]);
  });

  it('microphone test: the scan never disables Test; the start request checks the board', () => {
    // The button's markup is the microphone panel's. Here: the button reads only the test's own
    // state, and only a stop in flight disables it; Test itself is never disabled.
    expect(micTestAction('idle', false).disabled).toBe(false);
    for (const status of ['idle', 'done', 'error'] as const) {
      expect(micTestAction(status, true)).toEqual(micTestAction(status, false));
      expect(micTestAction(status, true).disabled).toBe(false);
    }
  });

  it('microphone test: it only speaks up about silence', () => {
    expect(micLevelNotice({ silent: true, peak_dbfs: null, rms_dbfs: null })).toMatch(
      /Nothing was picked up/,
    );
    expect(micLevelNotice({ silent: false, peak_dbfs: -9, rms_dbfs: -20 })).toBe('');
    expect(micLevelNotice(null)).toBe('');
  });

  it('microphone test: one button records, stops the recording, then stops the playback', () => {
    expect(micTestAction('idle', false)).toEqual({
      label: 'Test microphone',
      action: 'record',
      disabled: false,
    });
    // Stop is available the moment recording starts.
    expect(micTestAction('recording', false)).toEqual({
      label: 'Stop recording',
      action: 'stop',
      disabled: false,
    });
    expect(micTestAction('recording', true)).toEqual({
      label: 'Stopping…',
      action: 'stop',
      disabled: true,
    });
    expect(micTestAction('playing', false)).toEqual({
      label: 'Stop playing',
      action: 'stop-playing',
      disabled: false,
    });
    expect(micTestAction('done', false).action).toBe('record');
    expect(micTestAction('error', false).action).toBe('record');
  });

  it('the caption says how long it has recorded and when it plays', () => {
    expect(micTestCaption('recording', 0)).toBe('Recording · 0 s');
    expect(micTestCaption('recording', 4.9)).toBe('Recording · 4 s');
    expect(micTestCaption('recording', 75)).toBe('Recording · 1 min 15 s');
    expect(micTestCaption('playing', 12)).toBe('Recording playing');
    for (const status of ['idle', 'done', 'error'] as const) {
      expect(micTestCaption(status, 12)).toBe('');
    }
  });

  it("a finished test's recording is its board's route, naming the microphone and the test", () => {
    expect(micTestAudioUrl(readyTest({ id: 't 2' }))).toBe(testAudioUrl('t%202'));
  });

  // The status read never contacts the board, so a failed read is retried.

  /** A request that answers or throws each of `answers` in turn, counting its calls. */
  function requests(...answers: (MicTestStatus | null | Error)[]) {
    const calls: number[] = [];
    const request = async (): Promise<MicTestStatus | null> => {
      calls.push(calls.length);
      const answer = answers.shift();
      if (answer === undefined) throw new Error('No answer left');
      if (answer instanceof Error) throw answer;
      return answer;
    };
    return { request, calls };
  }
  const noWait = async () => undefined;

  it('a transient status failure is retried instead of ending the recording', async () => {
    const status = micTestStatus();
    const { request, calls } = requests(
      problem('network'),
      problem('peripheral_unavailable'),
      status,
    );
    await expect(readMicTest({ request, wait: noWait })).resolves.toEqual(status);
    expect(calls.length).toBe(3);
  });

  it('a status error that means the test is gone ends it at once', async () => {
    for (const code of ['not_found', 'board_changed']) {
      const { request, calls } = requests(problem(code), null);
      await expect(readMicTest({ request, wait: noWait })).rejects.toMatchObject({ code });
      expect(calls.length).toBe(1);
    }
  });

  it('retrying stops after the failure limit or once the page is gone', async () => {
    const limited = requests(...Array.from({ length: 5 }, () => problem('network')));
    await expect(
      readMicTest({ request: limited.request, wait: noWait, maxFailures: 3 }),
    ).rejects.toMatchObject({ code: 'network' });
    expect(limited.calls.length).toBe(3);

    const unmounted = requests(problem('network'), null);
    await expect(
      readMicTest({ request: unmounted.request, wait: noWait, isActive: () => false }),
    ).rejects.toMatchObject({ code: 'network' });
    expect(unmounted.calls.length).toBe(1);

    // A page that goes while the retry waits sends no further read.
    let active = true;
    const leaving = requests(problem('network'), null);
    await expect(
      readMicTest({
        request: leaving.request,
        wait: async () => {
          active = false;
        },
        isActive: () => active,
      }),
    ).rejects.toMatchObject({ code: 'network' });
    expect(leaving.calls.length).toBe(1);
  });
});
