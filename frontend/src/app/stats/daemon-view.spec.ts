import { daemonView, healthProblems, type SentinelReading } from './daemon-view';
import { failureOf } from './sentinel-failure';
import { sentinelError, sentinelHealth } from './stats.testing';

/** Sentinel answering on the board `local`. */
function reading(): SentinelReading {
  const answer = sentinelHealth();
  return { board: 'local', health: answer.health, startedAt: answer.started_at };
}

/** A health read's failure as the server answers it. */
const failed = (code: string, message = `Failed with ${code}.`, hint = '') =>
  failureOf(sentinelError(code, message, hint).error, 'local');

describe('daemonView', () => {
  it('a daemon that answers is running, with its version and its start', () => {
    expect(daemonView(reading(), null)).toEqual({
      state: 'ready',
      label: 'Running',
      version: 'main:80ab7de4da31',
      startedAt: '2026-10-24T09:30:00Z',
      command: '',
    });
    // A later read that failed without saying Sentinel is gone (a lost connection) keeps it ready.
    expect(daemonView(reading(), failed('timeout')).state).toBe('ready');
  });

  it('nothing read yet is unknown', () => {
    expect(daemonView(null, null)).toMatchObject({
      state: 'unknown',
      label: 'Unknown',
      command: '',
    });
  });

  it('a missing daemon comes with the command that installs it, to run on the board', () => {
    const missing = failureOf(sentinelError().error, 'local');
    expect(daemonView(null, missing)).toEqual({
      state: 'missing',
      label: 'Not installed',
      version: null,
      startedAt: null,
      command: 'sima-cli neat install sentinel',
    });
  });

  it('a stopped daemon comes with the command that starts it', () => {
    const stopped = failed(
      'sentinel_stopped',
      'Sentinel is installed on sima@192.168.1.20 but not running (inactive).',
      'Start it on the board with `sudo systemctl start simaai-sentinel`, then retry.',
    );
    expect(daemonView(null, stopped)).toMatchObject({
      state: 'stopped',
      label: 'Installed but stopped',
      command: 'sudo systemctl start simaai-sentinel',
    });
  });

  it('any other failure is a daemon not answering, with nothing to run', () => {
    for (const code of ['sentinel_denied', 'sentinel_schema', 'sentinel_failed', 'timeout']) {
      const failure = failed(code, 'x', 'Run `something` maybe.');
      expect(daemonView(null, failure), code).toMatchObject({
        state: 'error',
        label: 'Not answering',
        command: '',
      });
    }
  });
});

describe('healthProblems', () => {
  it('health stays readable: collector errors are strings or objects, and nothing else counts', () => {
    const health = (errors: SentinelReading['health']['errors']) => ({
      ...reading().health,
      errors,
    });
    expect(
      healthProblems(
        health(['pmbus read failed', { error: 'ev74 busy' }, { message: 'late' }, null, {}]),
      ),
    ).toEqual(['pmbus read failed', 'ev74 busy', 'late']);
    expect(healthProblems(health([]))).toEqual([]);
    expect(healthProblems({})).toEqual([]);
    expect(healthProblems(null)).toEqual([]);
  });
});
